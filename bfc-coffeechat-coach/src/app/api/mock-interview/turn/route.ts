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
  sumConversationChars,
} from "@/lib/mock-interview";

const LIMIT = 60;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-5-mini";
const MAX_TURN_CHARS = 4000;
const MAX_HISTORY_CHARS = 8000;

const conversationSchema = z.object({
  role: z.enum(["interviewer", "user"]),
  content: z.string().min(1),
});

const turnSchema = z.object({
  settings: settingsSchema,
  conversation: z.array(conversationSchema).default([]),
  lastQuestionId: z.string().min(1),
  askedQuestionIds: z.array(z.string()).default([]),
  lastUserTurn: z.string().min(1),
});

function buildInterviewerPrompt(
  settings: MockInterviewSettings,
  lastQuestionPrompt: string,
  nextQuestionPrompt: string | null,
  lastUserTurn: string,
  shouldFollowUp: boolean
) {
  const nextLine = shouldFollowUp
    ? `Ask a brief follow-up on: ${lastQuestionPrompt}`
    : `Ask the next question: ${nextQuestionPrompt}`;
  return `You are a friendly coffee chat interviewer. Acknowledge the user's answer briefly, then ask one question.
Keep it concise and speakable (<= 280 characters).

Last user answer:
${lastUserTurn}

${nextLine}

Settings:
- Firm: ${settings.firm}
- Stage: ${settings.stage}
`;
}

function buildRealtimeFeedbackPrompt(settings: MockInterviewSettings, lastUserTurn: string) {
  return `Provide concise coaching bullets for the user's last answer.
Format as 4-5 bullet lines:
- Tone/rapport
- Clarity/structure
- Referral readiness
- Better phrasing
- Next best question

Settings:
- Firm: ${settings.firm}
- Stage: ${settings.stage}

Answer:
${lastUserTurn}`;
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

  let body: z.infer<typeof turnSchema>;
  try {
    body = turnSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", requestId }, { status: 400 });
  }

  const { settings, conversation, askedQuestionIds, lastQuestionId, lastUserTurn } = body;

  if (lastUserTurn.length > MAX_TURN_CHARS) {
    return NextResponse.json({ error: "Answer too long", requestId }, { status: 413 });
  }

  if (sumConversationChars(conversation) > MAX_HISTORY_CHARS) {
    return NextResponse.json({ error: "Conversation history too long", requestId }, { status: 413 });
  }

  const questions = loadQuestionBank();
  const currentQuestion = questions.find((question) => question.id === lastQuestionId);
  if (!currentQuestion) {
    return NextResponse.json({ error: "Unknown question id", requestId }, { status: 400 });
  }

  const shouldFollowUp =
    settings.followUps && lastUserTurn.trim().length < 220 && lastUserTurn.split(" ").length < 50;

  let nextQuestion = null;
  if (!shouldFollowUp) {
    const eligible = filterQuestions(questions, settings, askedQuestionIds);
    nextQuestion = pickQuestion(eligible, settings.randomize);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  let interviewerText = "";
  try {
    const interviewerResp = await fetch("https://api.openai.com/v1/responses", {
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
              "You are a coffee chat interviewer. One question at a time, keep it friendly and concise.",
          },
          {
            role: "user",
            content: buildInterviewerPrompt(
              settings,
              currentQuestion.prompt,
              nextQuestion?.prompt || currentQuestion.prompt,
              lastUserTurn,
              shouldFollowUp
            ),
          },
        ],
      }),
    });

    if (!interviewerResp.ok) {
      const errorText = await interviewerResp.text();
      return NextResponse.json(
        { error: errorText || interviewerResp.statusText, requestId },
        { status: 502 }
      );
    }

    const data = await interviewerResp.json();
    interviewerText = extractOutputText(data);
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }

  if (!interviewerText) {
    return NextResponse.json({ error: "Empty model output", requestId }, { status: 502 });
  }

  let realtimeFeedback = "";
  try {
    const feedbackResp = await fetch("https://api.openai.com/v1/responses", {
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
              "You are a coffee chat coach. Keep feedback tight and skimmable.",
          },
          { role: "user", content: buildRealtimeFeedbackPrompt(settings, lastUserTurn) },
        ],
      }),
    });

    if (feedbackResp.ok) {
      const data = await feedbackResp.json();
      realtimeFeedback = extractOutputText(data);
    }
  } catch {
    // Non-blocking
  }

  if (!nextQuestion && !shouldFollowUp) {
    return NextResponse.json({
      interviewerText: capText(interviewerText, 280),
      realtimeFeedback,
      nextQuestionId: currentQuestion.id,
      done: true,
      requestId,
    });
  }

  return NextResponse.json({
    interviewerText: capText(interviewerText, 280),
    realtimeFeedback,
    nextQuestionId: shouldFollowUp ? currentQuestion.id : nextQuestion?.id || currentQuestion.id,
    done: false,
    requestId,
  });
}
