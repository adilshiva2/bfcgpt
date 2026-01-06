import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import z from "zod/v4";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { loadQuestionBank } from "@/lib/question-bank";
import {
  capText,
  filterQuestions,
  MockInterviewSettings,
  pickQuestion,
  settingsSchema,
} from "@/lib/mock-interview";

const LIMIT = 20;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-5-mini";

const startSchema = z.object({
  settings: settingsSchema,
});

function buildIntroPrompt(settings: MockInterviewSettings, questionPrompt: string) {
  return `You are a friendly coffee chat interviewer. Start with a brief greeting and small talk,
offer a quick 1-sentence intro about yourself, then ask the question naturally.
Keep it short and speakable (<= 280 characters).

Question: ${questionPrompt}
Firm: ${settings.firm}
Stage: ${settings.stage}
`;
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

  let body: z.infer<typeof startSchema>;
  try {
    body = startSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", requestId }, { status: 400 });
  }

  const settings = body.settings;
  const questions = loadQuestionBank();
  const eligible = filterQuestions(questions, settings);
  const firstQuestion = pickQuestion(eligible, settings.randomize);

  if (!firstQuestion) {
    return NextResponse.json(
      { error: "No questions available for the selected settings.", requestId },
      { status: 400 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            role: "system",
            content:
              "You are a coffee chat interviewer. Keep responses concise, friendly, and one question at a time.",
          },
          { role: "user", content: buildIntroPrompt(settings, firstQuestion.prompt) },
        ],
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return NextResponse.json(
        { error: errorText || resp.statusText, requestId },
        { status: 502 }
      );
    }

    const data = await resp.json();
    const interviewerText = extractOutputText(data);
    if (!interviewerText) {
      return NextResponse.json({ error: "Empty model output", requestId }, { status: 502 });
    }

    return NextResponse.json({
      interviewerText: capText(interviewerText, 280),
      realtimeFeedback: "",
      questionId: firstQuestion.id,
      requestId,
    });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
