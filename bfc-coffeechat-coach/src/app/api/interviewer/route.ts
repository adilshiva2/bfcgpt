import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";

const LIMIT = 20;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TOTAL_CHARS = 4000;
const MAX_MESSAGE_CHARS = 1000;

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

type InterviewerRequest = {
  messages?: Message[];
  scenario?: ScenarioPayload;
};

function buildSystemPrompt(scenario: ScenarioPayload) {
  return `You are a realistic finance coffee chat interviewer.
- Ask exactly 1 question at a time.
- Adapt follow-ups to the user's answers.
- Politely challenge vague answers.
- Steer toward why this firm/group/role.
- The goal is earning a referral naturally; if asked too early, redirect and revisit later.
- Keep each response <= 280 characters for TTS.

Scenario:
- Track: ${scenario.track}
- Firm type: ${scenario.firmType}
- Group: ${scenario.group}
- Interviewer vibe: ${scenario.interviewerVibe}
- Difficulty: ${scenario.difficulty}
- Goal: ${scenario.goal}
`;
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

  const rate = enforceUserRateLimit({ key: email, limit: LIMIT, windowMs: WINDOW_MS });
  if (!rate.allowed) {
    const retryAfter = Math.ceil(rate.retryAfterMs / 1000);
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`, requestId },
      {
        status: 429,
        headers: { "Retry-After": retryAfter.toString() },
      }
    );
  }

  let body: InterviewerRequest = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const scenario = body.scenario;
  if (!scenario) {
    return NextResponse.json({ error: "Missing scenario", requestId }, { status: 400 });
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
    model: "gpt-5-mini",
    input: [
      { role: "system", content: buildSystemPrompt(scenario) },
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
        { status: resp.status }
      );
    }

    const data = await resp.json();
    const outputText = (data?.output_text || "").trim();

    if (!outputText) {
      return NextResponse.json({ error: "Empty model output", requestId }, { status: 502 });
    }

    const interviewerText = outputText.slice(0, 280);
    return NextResponse.json({ interviewerText, requestId });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
