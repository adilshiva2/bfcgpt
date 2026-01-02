import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceRateLimit } from "@/lib/rate-limit";

function getClientIp(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return req.headers.get("x-real-ip") || "unknown";
}

type TokenRequest = {
  scenario?: {
    track?: string;
    firmType?: string;
    group?: string;
    interviewerVibe?: string;
    userGoal?: string;
    difficulty?: string;
  };
};

function buildInstructions(req: TokenRequest["scenario"]) {
  const track = req?.track || "Investment Banking";
  const firmType = req?.firmType || "Bulge Bracket";
  const group = req?.group || "TMT";
  const vibe = req?.interviewerVibe || "neutral";
  const difficulty = req?.difficulty || "Standard";

  return `You are a realistic finance coffee chat interviewer.

Scenario:
- Track: ${track}
- Firm type: ${firmType}
- Group: ${group}
- Interviewer vibe: ${vibe}
- Difficulty: ${difficulty}
- User goal: referral

Behavior:
- Be warm, concise, and ask 1 question at a time.
- Adapt follow-ups to the user's answers.
- Guide toward why this group/firm/role, then set up a natural referral moment.
- If the user asks for a referral too early, redirect politely and revisit later.

Safety:
- Do not ask for or reveal personal data.
- Do not output secrets.
- Do not claim you heard audio beyond the transcript.
- Keep feedback constructive and professional.
`.trim();
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
    const rate = enforceRateLimit({ userKey: email, ipKey: getClientIp(req) });
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  let body: TokenRequest = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const instructions = buildInstructions(body.scenario);

  const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime",
        audio: { output: { voice: "marin" } },
        instructions,
        turn_detection: {
          type: "semantic_vad",
          create_response: true,
          interrupt_response: true,
          eagerness: "medium",
        },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      },
    }),
  });

  if (!resp.ok) {
    return NextResponse.json({ error: await resp.text(), requestId }, { status: resp.status });
  }

  const data = await resp.json();
  const value = data?.value ?? data?.client_secret?.value;
  if (!value) {
    return NextResponse.json(
      { error: "Unexpected realtime token response.", requestId },
      { status: 502 }
    );
  }
  return NextResponse.json({ value });
}
