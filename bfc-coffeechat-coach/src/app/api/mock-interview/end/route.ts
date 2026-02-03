import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import z from "zod/v4";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import {
  type InterviewMode,
  interviewModeConfigs,
  settingsSchema,
  sumConversationChars,
} from "@/lib/mock-interview";

const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-4o-mini";
const MAX_HISTORY_CHARS = 8000;

const conversationSchema = z.object({
  role: z.enum(["interviewer", "user"]),
  content: z.string().min(1),
});

const endSchema = z.object({
  settings: settingsSchema,
  interviewMode: z.string().optional(),
  askedQuestionIds: z.array(z.string()).default([]),
  conversation: z.array(conversationSchema).default([]),
});

function buildSummaryPrompt(
  settings: z.infer<typeof settingsSchema>,
  conversation: string,
  modeLabel: string,
  modeContext: string,
  gradingFocus: string
) {
  return `Provide a final summary for a ${modeLabel} mock interview.
Include:
- Top 3 improvements (specific to ${modeLabel} interview expectations)
- Suggested 30-sec intro rewrite tailored to the firm/role
- Best 3 follow-up questions tailored to the scenario
- Overall readiness assessment for this interview type
${gradingFocus ? `- Apply this grading lens: ${gradingFocus}` : ""}
${modeContext ? `\nInterview context:\n${modeContext}\n` : ""}
Settings:
- Firm: ${settings.firm}
- Stage: ${settings.stage}

Conversation:
${conversation}`;
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

  let body: z.infer<typeof endSchema>;
  try {
    body = endSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", requestId }, { status: 400 });
  }

  if (sumConversationChars(body.conversation) > MAX_HISTORY_CHARS) {
    return NextResponse.json({ error: "Conversation history too long", requestId }, { status: 413 });
  }

  const mode = (body.interviewMode || "standard") as InterviewMode;
  const modeConfig = interviewModeConfigs[mode] || interviewModeConfigs.standard;

  const conversationText = (body.conversation as Array<{ role: "interviewer" | "user"; content: string }>)
    .map((msg) => `${msg.role === "interviewer" ? "Interviewer" : "User"}: ${msg.content}`)
    .join("\n");

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
            content: `You are a mock interview coach specializing in ${modeConfig.label} interviews. Keep the summary concise and practical.`,
          },
          {
            role: "user",
            content: buildSummaryPrompt(
              body.settings,
              conversationText,
              modeConfig.label,
              modeConfig.promptContext,
              modeConfig.gradingFocus
            ),
          },
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
    const finalSummary = extractOutputText(data);
    if (!finalSummary) {
      return NextResponse.json({ error: "Empty model output", requestId }, { status: 502 });
    }

    return NextResponse.json({ finalSummary, requestId });
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }
}
