import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";

const MODEL = "gpt-5-mini";
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TOTAL_CHARS = 6000;
const MAX_MESSAGE_CHARS = 1200;

type ScenarioPayload = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  difficulty: string;
  goal: "referral";
};

type Message = {
  role: "user" | "interviewer";
  content: string;
};

type FinalCoachRequest = {
  messages?: Message[];
  scenario?: ScenarioPayload;
};

function buildPrompt(messages: Message[], scenario: ScenarioPayload) {
  const transcript = messages
    .map((msg) => `${msg.role === "interviewer" ? "Interviewer" : "User"}: ${msg.content}`)
    .join("\n");

  return `Create an end-of-call summary for a coffee chat practice.
Output plain text with sections:
- Top 3 improvements
- Suggested 30-second intro rewrite
- Best 3 questions tailored to the scenario
- Referral ask script + timing advice

Scenario:
- Track: ${scenario.track}
- Firm type: ${scenario.firmType}
- Group: ${scenario.group}
- Vibe: ${scenario.interviewerVibe}
- Difficulty: ${scenario.difficulty}
- Goal: ${scenario.goal}

Conversation transcript:
${transcript}`;
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

function buildDebugMeta(data: unknown) {
  const payload = data as {
    output?: Array<{ type?: string }>;
    refusal?: unknown;
  };
  const outputItems = Array.isArray(payload?.output) ? payload.output : [];
  return {
    modelUsed: MODEL,
    outputKeys: Object.keys((payload as Record<string, unknown>) || {}),
    outputItemTypes: outputItems.map((item) => item?.type).filter(Boolean),
    hadRefusal: Boolean(payload?.refusal),
  };
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

  let body: FinalCoachRequest = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const scenario = body.scenario;
  if (!scenario || messages.length === 0) {
    return NextResponse.json(
      { error: "Missing messages or scenario", requestId },
      { status: 400 }
    );
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

  const payload = {
    model: MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a coffee chat coach. Keep the summary concise and practical. Output plain text.",
      },
      { role: "user", content: buildPrompt(messages, scenario) },
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
          ...(process.env.NEXT_PUBLIC_DEBUG_INTERVIEW === "true" ? buildDebugMeta(data) : {}),
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ finalSummary: outputText.trim(), requestId });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
