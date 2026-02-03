import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";

const MODEL = "gpt-4o-mini";
const LIMIT = 120;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TURN_CHARS = 1200;

type ScenarioPayload = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  difficulty: string;
  goal: "referral";
  phase?: string;
};

type LiveCoachRequest = {
  lastUserTurn?: string;
  scenario?: ScenarioPayload;
  phase?: string;
};

function buildPrompt(lastUserTurn: string, scenario: ScenarioPayload, phase: string) {
  return `Classify the user's last answer for a coffee chat. Output strict JSON only.

Return JSON with keys:
- tone (warm/neutral/abrupt)
- clarity (clear/rambling/vague)
- structure (has story/missing story)
- referral (too early/building/ready)
- bullets (array of 2 short bullet strings)

Scenario:
- Track: ${scenario.track}
- Firm type: ${scenario.firmType}
- Group: ${scenario.group}
- Vibe: ${scenario.interviewerVibe}
- Difficulty: ${scenario.difficulty}
- Phase: ${phase}

Last user answer:
${lastUserTurn}`;
}

function heuristicLiveCoach(text: string) {
  const lower = text.toLowerCase();
  const fillerWords = ["um", "uh", "like", "you know", "sort of", "kind of"];
  const fillerCount = fillerWords.reduce((sum, word) => sum + (lower.split(word).length - 1), 0);
  const longAnswer = text.length > 500;
  const questions = (text.match(/\?/g) || []).length;
  const entitlement = /(i deserve|i should|get me|give me)/i.test(text);

  return {
    tone: entitlement ? "abrupt" : "neutral",
    clarity: longAnswer ? "rambling" : "clear",
    structure: questions === 0 ? "missing story" : "has story",
    referral: entitlement ? "too early" : "building",
    bullets: [
      fillerCount > 2 ? "Reduce filler words to sound more confident." : "Keep the tone warm and concise.",
      questions === 0 ? "Add one specific question to show curiosity." : "Good use of a question—stay focused.",
    ],
  };
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

  let body: LiveCoachRequest = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const lastUserTurn = (body.lastUserTurn || "").trim();
  const scenario = body.scenario;
  const phase = (body.phase || scenario?.phase || "exploration").toString();

  if (!lastUserTurn || !scenario) {
    return NextResponse.json(
      { error: "Missing lastUserTurn or scenario", requestId },
      { status: 400 }
    );
  }
  if (lastUserTurn.length > MAX_TURN_CHARS) {
    return NextResponse.json({ error: "User turn too long", requestId }, { status: 413 });
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
          "You are a coffee chat coach. Output must be JSON only, no markdown. Keep bullets short.",
      },
      { role: "user", content: buildPrompt(lastUserTurn, scenario, phase) },
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

    try {
      const parsed = JSON.parse(outputText) as {
        tone: string;
        clarity: string;
        structure: string;
        referral: string;
        bullets: string[];
      };
      if (
        parsed?.tone &&
        parsed?.clarity &&
        parsed?.structure &&
        parsed?.referral &&
        Array.isArray(parsed.bullets)
      ) {
        return NextResponse.json({ ...parsed, requestId });
      }
    } catch {
      // fall through to heuristic
    }

    const fallback = heuristicLiveCoach(lastUserTurn);
    return NextResponse.json({ ...fallback, requestId });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
