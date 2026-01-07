import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import z from "zod/v4";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { questionTypeSchema } from "@/lib/mock-interview";

const LIMIT = 90;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-5-mini";
const MAX_ANSWER_CHARS = 4000;

const planItemSchema = z.object({
  qIndex: z.number().int().min(1),
  type: questionTypeSchema,
  interviewerQuestion: z.string().min(1),
  expectedRubric: z.string().min(1),
  idealAnswerOutline: z.string().min(1),
});

const gradeSchema = z.object({
  planItem: planItemSchema,
  userAnswer: z.string().min(1),
  firm: z.string(),
  stage: z.string(),
});

const gradeResponseSchema = z.object({
  score0to10: z.number().min(0).max(10),
  strengths: z.array(z.string()).min(1),
  gaps: z.array(z.string()).min(1),
  correctedAnswerOutline: z.string().min(1),
  nextBestSentence: z.string().min(1),
});

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

function parseJsonFromText(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
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

  let body: z.infer<typeof gradeSchema>;
  try {
    body = gradeSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", requestId }, { status: 400 });
  }

  if (body.userAnswer.length > MAX_ANSWER_CHARS) {
    return NextResponse.json({ error: "Answer too long", requestId }, { status: 413 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  const prompt = `Grade the user's answer against the rubric and ideal outline.
Return strict JSON with:
score0to10 (0-10),
strengths (array),
gaps (array),
correctedAnswerOutline (bullets),
nextBestSentence (single sentence).

Firm: ${body.firm}
Stage: ${body.stage}

Question: ${body.planItem.interviewerQuestion}

Expected rubric:
${body.planItem.expectedRubric}

Ideal outline:
${body.planItem.idealAnswerOutline}

User answer:
${body.userAnswer}`;

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
              "You are a finance interview coach. Output valid JSON only, no markdown.",
          },
          { role: "user", content: prompt },
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
    const outputText = extractOutputText(data);
    const parsed = parseJsonFromText(outputText);
    const validated = gradeResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid grading output", requestId }, { status: 502 });
    }

    const result = validated.data;
    const score0to10 = Math.max(0, Math.min(10, result.score0to10));
    return NextResponse.json({
      score0to10,
      strengths: result.strengths,
      gaps: result.gaps,
      correctedAnswerOutline: result.correctedAnswerOutline,
      nextBestSentence: result.nextBestSentence,
      requestId,
    });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
