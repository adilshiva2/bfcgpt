import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import z from "zod/v4";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { loadQuestionBank } from "@/lib/question-bank";
import {
  capText,
  questionTypeOptions,
  settingsSchema,
  questionTypeSchema,
} from "@/lib/mock-interview";

const LIMIT = 20;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-5-mini";

const planSchema = z.object({
  firm: z.string(),
  stage: settingsSchema.shape.stage,
  questionTypes: z.array(z.union([questionTypeSchema, z.literal("all")])).default([]),
  numQuestions: z.number().min(1).max(12).default(6),
  randomize: z.boolean().optional(),
});

const planItemSchema = z.object({
  qIndex: z.number().int().min(1),
  type: questionTypeSchema,
  interviewerQuestion: z.string().min(1),
  expectedRubric: z.string().min(1),
  idealAnswerOutline: z.string().min(1),
});

const planResponseSchema = z.object({
  plan: z.array(planItemSchema).min(1),
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

function normalizeTypes(types: string[]) {
  if (!types || types.length === 0 || types.includes("all")) {
    return questionTypeOptions;
  }
  return types.filter((type) => questionTypeOptions.includes(type as (typeof questionTypeOptions)[number]));
}

function selectSeeds(
  questions: ReturnType<typeof loadQuestionBank>,
  firm: string,
  stage: string,
  types: string[]
) {
  const normalizedTypes = normalizeTypes(types);
  const byFirmStageType = questions.filter(
    (question) =>
      question.firm === firm &&
      question.stage === stage &&
      normalizedTypes.includes(question.questionType)
  );
  if (byFirmStageType.length > 0) return { seeds: byFirmStageType, seedCount: byFirmStageType.length };

  const byFirmStage = questions.filter(
    (question) => question.firm === firm && question.stage === stage
  );
  if (byFirmStage.length > 0) return { seeds: byFirmStage, seedCount: byFirmStage.length };

  const byFirm = questions.filter((question) => question.firm === firm);
  if (byFirm.length > 0) return { seeds: byFirm, seedCount: byFirm.length };

  return { seeds: [], seedCount: 0 };
}

function shuffle<T>(arr: T[]) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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

  let body: z.infer<typeof planSchema>;
  try {
    body = planSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", requestId }, { status: 400 });
  }

  const questions = loadQuestionBank();
  const { seeds, seedCount } = selectSeeds(questions, body.firm, body.stage, body.questionTypes);
  if (seedCount === 0) {
    return NextResponse.json(
      {
        error: `No questions found for firm ${body.firm}.`,
        requestId,
      },
      { status: 404 }
    );
  }

  const targetCount = Math.min(body.numQuestions, Math.max(1, seedCount));
  const seedPool = body.randomize ? shuffle(seeds) : seeds;
  const seedSlice = seedPool.slice(0, Math.min(seedPool.length, Math.max(8, targetCount)));
  const seedList = seedSlice
    .map((seed, idx) => `${idx + 1}. [${seed.questionType}] ${seed.prompt}`)
    .join("\n");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  const prompt = `You are creating a mock interview plan. Use the seed questions below as grounding.
Create a plan of ${targetCount} questions. Questions should be similar or rephrased, not invented.
Return strict JSON with the shape: { "plan": [ ... ] }.

Each plan item must include:
- qIndex (1-based)
- type (behavioral|accounting|valuation|lbo|merger_math|market|brainteaser|other)
- interviewerQuestion (<= 280 characters)
- expectedRubric (bullet rubric, speak-independent)
- idealAnswerOutline (bullets)

Firm: ${body.firm}
Stage: ${body.stage}

Seed questions:
${seedList}`;

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
              "You are a structured planner. Output valid JSON only, no markdown or commentary.",
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
    const validated = planResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid plan output", requestId }, { status: 502 });
    }

    const plan = validated.data.plan
      .slice(0, targetCount)
      .map((item: z.infer<typeof planItemSchema>, index: number) => ({
        ...item,
        qIndex: index + 1,
        interviewerQuestion: capText(item.interviewerQuestion, 280),
      }));

    return NextResponse.json({
      plan,
      seedCount,
      requestId,
    });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
