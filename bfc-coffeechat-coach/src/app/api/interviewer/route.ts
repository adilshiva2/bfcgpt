import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";

const LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TOTAL_CHARS = 4000;
const MAX_MESSAGE_CHARS = 1000;
const MODEL = "gpt-4o-mini";

type ScenarioPayload = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  difficulty: string;
  goal: "referral";
  phase?: string;
  persona?: {
    name: string;
    title: string;
    firm: string;
    group: string;
  };
};

type Message = {
  role: "user" | "interviewer";
  content: string;
};

type InterviewerRequest = {
  messages?: Message[];
  scenario?: ScenarioPayload;
  turnIndex?: number;
  lastInterviewerText?: string;
};

function buildSystemPrompt(
  scenario: ScenarioPayload,
  hasUserMessages: boolean,
  lastInterviewerText?: string
) {
  const phase = scenario.phase || "opening";
  const persona = scenario.persona;
  const personaLine = persona
    ? `Interviewer persona: ${persona.name}, ${persona.title} at ${persona.firm} (${persona.group}).`
    : "Interviewer persona: a finance professional at the target firm.";

  const phaseGuidance: Record<string, string> = {
    opening:
      "Start with a warm greeting + small talk + permission to chat. Give a 15–25 second 'about me' intro. Then invite the user to share their 30-second background.",
    user_intro: "Acknowledge their intro and ask a gentle follow-up to deepen their story.",
    exploration: "Explore their interests and what drew them to finance in a conversational way.",
    fit: "Ask why this firm/group/role with natural phrasing, not an interview tone.",
    user_questions: "Invite their questions and respond briefly. Encourage 1-2 thoughtful questions.",
    close: "Wrap up with a friendly close and a natural referral moment if appropriate.",
  };

  const introGuard = hasUserMessages
    ? "The user has already spoken. Do NOT reintroduce yourself; respond naturally to their message."
    : "Only provide the full intro/greeting when there are no user messages yet.";

  const dedupLine = lastInterviewerText
    ? `\nYour last response was: "${lastInterviewerText}"\nDo NOT repeat or closely rephrase it. Ask a different follow-up.`
    : "";

  return `You are a realistic finance coffee chat interviewer.
- Ask exactly 1 question at a time.
- Keep a warm, conversational tone (not an interview).
- Adapt follow-ups to the user's answers.
- Politely challenge vague answers.
- The goal is earning a referral naturally; if asked too early, redirect and revisit later.
- CRITICAL: Keep each response <= 280 characters. Be concise.
- Include brief acknowledgments before the next question.

${personaLine}

Phase guidance: ${phaseGuidance[phase] || phaseGuidance.opening}
${introGuard}${dedupLine}

Scenario:
- Track: ${scenario.track}
- Firm type: ${scenario.firmType}
- Group: ${scenario.group}
- Interviewer vibe: ${scenario.interviewerVibe}
- Difficulty: ${scenario.difficulty}
- Goal: ${scenario.goal}
`;
}

function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const sub = text.slice(0, maxLen);
  const lastPeriod = sub.lastIndexOf(".");
  const lastQuestion = sub.lastIndexOf("?");
  const lastExcl = sub.lastIndexOf("!");
  const cutoff = Math.max(lastPeriod, lastQuestion, lastExcl);
  if (cutoff > maxLen * 0.4) return text.slice(0, cutoff + 1).trim();
  return `${sub.slice(0, maxLen - 3).trimEnd()}...`;
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID();
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  }
  if (!isAllowedEmail(email)) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  if (process.env.NODE_ENV === "production") {
    const rate = enforceUserRateLimit({ key: email, limit: LIMIT, windowMs: WINDOW_MS });
    if (!rate.allowed) {
      const retryAfter = Math.ceil(rate.retryAfterMs / 1000);
      return NextResponse.json(
        {
          error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          requestId,
          retryAfterSeconds: retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": retryAfter.toString() },
        }
      );
    }
  }

  let body: InterviewerRequest = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const scenario = body.scenario;
  const lastInterviewerText = (body.lastInterviewerText || "").trim();
  if (!scenario) {
    return NextResponse.json({ error: "Missing scenario", requestId }, { status: 400 });
  }
  if (messages.length === 0) {
    return NextResponse.json({ error: "Missing messages", requestId }, { status: 400 });
  }

  let totalChars = 0;
  for (const msg of messages) {
    if (!msg?.content || typeof msg.content !== "string") {
      return NextResponse.json({ error: "Invalid message content", requestId }, { status: 400 });
    }
    if (msg.content.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json({ error: "Message too long", requestId }, { status: 413 });
    }
    totalChars += msg.content.length;
  }

  if (totalChars > MAX_TOTAL_CHARS) {
    return NextResponse.json({ error: "Payload too large", requestId }, { status: 413 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  const hasUserMessages = messages.some((msg) => msg.role === "user");

  const payload = {
    model: MODEL,
    input: [
      {
        role: "system",
        content: buildSystemPrompt(
          scenario,
          hasUserMessages,
          lastInterviewerText || undefined
        ),
      },
      ...messages.map((msg) => ({
        role: msg.role === "interviewer" ? "assistant" : "user",
        content: msg.content,
      })),
    ],
  };

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return NextResponse.json(
        { error: errorText || resp.statusText, requestId },
        { status: 502 }
      );
    }

    const data = await resp.json();
    const outputText = extractOutputText(data);

    if (!outputText) {
      return NextResponse.json(
        {
          error: "Empty model output",
          requestId,
          ...(process.env.NEXT_PUBLIC_DEBUG_INTERVIEW === "true"
            ? buildDebugMeta(data, MODEL)
            : {}),
        },
        { status: 502 }
      );
    }

    const interviewerText = truncateAtSentence(outputText.trim(), 280);
    return NextResponse.json({ interviewerText, requestId });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}

function extractOutputText(data: unknown) {
  const payload = data as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  };
  const direct = typeof payload?.output_text === "string" ? payload.output_text.trim() : "";
  if (direct) return direct;
  const outputItems = Array.isArray(payload?.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of outputItems) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("").trim();
}

function buildDebugMeta(data: unknown, modelUsed: string) {
  const payload = data as {
    output?: Array<{ type?: string }>;
    refusal?: unknown;
  };
  const outputItems = Array.isArray(payload?.output) ? payload.output : [];
  return {
    modelUsed,
    outputKeys: Object.keys((payload as Record<string, unknown>) || {}),
    outputItemTypes: outputItems.map((item) => item?.type).filter(Boolean),
    hadRefusal: Boolean(payload?.refusal),
  };
}

