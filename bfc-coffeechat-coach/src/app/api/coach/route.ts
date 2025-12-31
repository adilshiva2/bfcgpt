import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceRateLimit } from "@/lib/rate-limit";

type CoachScenario = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  userGoal: string;
};

type CoachRequest = {
  transcript?: string;
  scenario?: CoachScenario;
};

function buildPrompt(transcript: string, scenario: CoachScenario) {
  return `You are a coffee chat coach helping the user earn a referral. Provide concise, actionable feedback in markdown.\n\nScenario:\n- Track: ${scenario.track}\n- Firm type: ${scenario.firmType}\n- Group: ${scenario.group}\n- Interviewer vibe: ${scenario.interviewerVibe}\n- User goal: ${scenario.userGoal}\n\nTranscript:\n${transcript}`;
}

function normalizeTranscript(input: string) {
  const collapsedWhitespace = input.replace(/\s+/g, " ").trim();
  return collapsedWhitespace.replace(/(\S)\1{5,}/g, "$1$1$1");
}

function getClientIp(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return req.headers.get("x-real-ip") || "unknown";
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timeoutId);
  }
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

  const rate = enforceRateLimit({ userKey: email, ipKey: getClientIp(req) });
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  let body: CoachRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const transcript = normalizeTranscript(body.transcript || "");
  const scenario = body.scenario;

  if (!transcript || !scenario) {
    return NextResponse.json({ error: "Missing transcript or scenario", requestId }, { status: 400 });
  }

  if (transcript.length > 3000) {
    return NextResponse.json(
      { error: "Transcript too long. Keep it under 3,000 characters.", requestId },
      { status: 413 }
    );
  }

  const prompt = buildPrompt(transcript, scenario);

  if (process.env.NODE_ENV === "production") {
    console.info(`[coach] request ${requestId} length=${transcript.length}`);
  }

  const payload = {
    model: "gpt-4o-mini",
    max_output_tokens: 400,
    input: [
      {
        role: "system",
        content:
          "You are a coffee chat coach. Output must be concise markdown. Do not request or infer personal data. Do not output secrets. Do not claim you heard audio—only use the text transcript. Keep feedback professional and constructive. Follow this rubric: 1) What they did well (2 bullets). 2) What hurt rapport (tone, interruptions, entitlement). 3) Question quality (too generic? too long? too early for referral ask?). 4) A better next question (1-2 examples). 5) A clean referral ask line tailored to the scenario.",
      },
      { role: "user", content: prompt },
    ],
  };

  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchWithTimeout(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        15000
      );

      if (response.status >= 500 && attempt === 0) {
        continue;
      }
      break;
    } catch {
      if (attempt === 0) {
        continue;
      }
      return NextResponse.json(
        { error: "Upstream request failed.", requestId },
        { status: 502 }
      );
    }
  }

  if (!response) {
    return NextResponse.json({ error: "Upstream request failed.", requestId }, { status: 502 });
  }

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: errorText || response.statusText, requestId },
      { status: response.status }
    );
  }

  const data = await response.json();
  const outputText =
    data?.output_text ||
    data?.output?.[0]?.content?.find((item: { type: string; text?: string }) => item.type === "output_text")
      ?.text ||
    "";

  if (!outputText) {
    return NextResponse.json({ error: "No feedback returned", requestId }, { status: 502 });
  }

  return NextResponse.json({ feedback: outputText.trim() });
}
