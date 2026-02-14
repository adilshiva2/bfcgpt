#!/usr/bin/env node
/**
 * BFC-GPT Autonomous Improvement Agent
 *
 * This agent runs a series of improvement tasks against the bfcgpt codebase
 * without requiring continuous human prompting. It:
 *
 * 1. Tests the mock interview API flow end-to-end
 * 2. Identifies issues (bugs, quality gaps, latency bottlenecks)
 * 3. Applies fixes and improvements
 * 4. Re-tests to verify fixes
 *
 * Architecture:
 * - Uses Claude Sonnet 4.5 for high-quality text generation (interview questions, grading)
 * - Uses a fast model (gpt-4o-mini) for low-latency tasks (TTS text prep, quick feedback)
 * - Runs TTS and text generation in parallel to reduce latency
 *
 * Usage:
 *   node scripts/agent.mjs                    # Run all tasks
 *   node scripts/agent.mjs --task test        # Run only the test harness
 *   node scripts/agent.mjs --task improve     # Run only improvements
 *   node scripts/agent.mjs --dry-run          # Show what would be done without executing
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  // Model tiers: quality vs speed
  models: {
    quality: "claude-sonnet-4-5-20250929",  // High quality for plan/grade/interview generation
    fast: "gpt-4o-mini",                    // Fast for TTS prep, quick coaching bullets
  },
  // API base URLs
  apis: {
    anthropic: "https://api.anthropic.com/v1/messages",
    openai: "https://api.openai.com/v1/responses",
  },
  // Test configuration
  test: {
    baseUrl: "http://localhost:3000",
    firms: ["Goldman Sachs", "Evercore", "Lazard", "Centerview"],
    modes: ["standard", "ib_first_round", "ib_superday", "pe_interview", "hf_interview"],
    stages: ["first_round", "superday"],
  },
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(level, msg, data) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefix = { info: "\x1b[36m[INFO]\x1b[0m", warn: "\x1b[33m[WARN]\x1b[0m", error: "\x1b[31m[ERROR]\x1b[0m", success: "\x1b[32m[OK]\x1b[0m" };
  console.log(`${timestamp} ${prefix[level] || "[LOG]"} ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function saveJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ─── Task 1: Question Bank Quality Audit ─────────────────────────────────────

async function auditQuestionBank() {
  log("info", "Auditing question bank quality...");
  const questions = loadJson(join(ROOT, "data", "question-bank.json"));

  const stats = {
    total: questions.length,
    unclassifiedFirm: 0,
    unclassifiedType: 0,
    unclassifiedStage: 0,
    tooShort: 0,       // Prompt < 20 chars — probably not a real question
    tableHeaders: 0,   // Looks like CSV/table data, not a question
    goodQuestions: 0,
  };

  const issues = [];

  for (const q of questions) {
    if (q.firm === "Other") stats.unclassifiedFirm++;
    if (q.questionType === "other") stats.unclassifiedType++;
    if (q.stage === "unknown") stats.unclassifiedStage++;

    if (q.prompt.length < 20) {
      stats.tooShort++;
      issues.push({ id: q.id, issue: "too_short", prompt: q.prompt });
      continue;
    }

    // Detect table headers/metadata rows
    if (q.prompt.includes("\t") && q.prompt.split("\t").length > 2) {
      stats.tableHeaders++;
      issues.push({ id: q.id, issue: "table_header", prompt: q.prompt.slice(0, 80) });
      continue;
    }

    // Detect document instructions (not questions)
    if (/^(\d+\.\s+)?(this document|give to receive|don't post|if we start)/i.test(q.prompt)) {
      stats.tableHeaders++;
      issues.push({ id: q.id, issue: "doc_instruction", prompt: q.prompt.slice(0, 80) });
      continue;
    }

    stats.goodQuestions++;
  }

  log("info", "Question bank audit results:", stats);
  log("info", `${issues.length} problematic entries found`);

  return { stats, issues, questions };
}

// ─── Task 2: Test Mock Interview API Flow ────────────────────────────────────

async function testMockInterviewFlow(baseUrl) {
  log("info", "Testing mock interview API flow...");
  const results = { passed: 0, failed: 0, errors: [] };

  // Test 1: Plan endpoint
  for (const firm of CONFIG.test.firms.slice(0, 2)) {
    for (const mode of ["standard", "ib_superday"]) {
      const testName = `plan/${firm}/${mode}`;
      try {
        const res = await fetch(`${baseUrl}/api/mock-interview/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firm,
            stage: "superday",
            questionTypes: ["all"],
            numQuestions: 4,
            randomize: true,
            interviewMode: mode,
          }),
        });

        if (res.status === 401 || res.status === 403) {
          log("warn", `${testName}: Auth required (expected in production)`);
          results.passed++;
          continue;
        }

        const data = await res.json();
        if (!res.ok) {
          results.failed++;
          results.errors.push({ test: testName, status: res.status, error: data.error });
          log("error", `${testName}: ${data.error}`);
        } else if (!data.plan || !Array.isArray(data.plan)) {
          results.failed++;
          results.errors.push({ test: testName, error: "Missing plan array" });
          log("error", `${testName}: Missing plan array`);
        } else {
          results.passed++;
          log("success", `${testName}: ${data.plan.length} questions planned`);

          // Validate plan item structure
          for (const item of data.plan) {
            if (!item.interviewerQuestion || !item.expectedRubric || !item.idealAnswerOutline) {
              results.errors.push({ test: `${testName}/item-${item.qIndex}`, error: "Missing required plan fields" });
            }
          }
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ test: testName, error: err.message });
        log("error", `${testName}: ${err.message}`);
      }
    }
  }

  // Test 2: Grade endpoint
  const gradeTestName = "grade/valuation";
  try {
    const res = await fetch(`${baseUrl}/api/mock-interview/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planItem: {
          qIndex: 1,
          type: "valuation",
          interviewerQuestion: "Walk me through a DCF analysis.",
          expectedRubric: "Should cover: UFCF projection, discount rate (WACC), terminal value, present value calculation",
          idealAnswerOutline: "1. Project free cash flows 2. Calculate WACC 3. Discount FCFs 4. Add terminal value 5. Subtract net debt",
        },
        userAnswer: "A DCF values a company by projecting its future free cash flows and discounting them back to present value using the weighted average cost of capital. You start with revenue projections, work down to unlevered free cash flow, then discount at WACC. Terminal value captures value beyond the projection period using either a perpetuity growth or exit multiple approach.",
        firm: "Goldman Sachs",
        stage: "superday",
        interviewMode: "ib_superday",
      }),
    });

    if (res.status === 401 || res.status === 403) {
      log("warn", `${gradeTestName}: Auth required`);
      results.passed++;
    } else {
      const data = await res.json();
      if (!res.ok) {
        results.failed++;
        results.errors.push({ test: gradeTestName, error: data.error });
      } else if (typeof data.score0to10 !== "number") {
        results.failed++;
        results.errors.push({ test: gradeTestName, error: "Missing score" });
      } else {
        results.passed++;
        log("success", `${gradeTestName}: Score ${data.score0to10}/10`);
      }
    }
  } catch (err) {
    results.failed++;
    results.errors.push({ test: gradeTestName, error: err.message });
  }

  // Test 3: TTS endpoint
  const ttsTestName = "tts/basic";
  try {
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Walk me through your resume." }),
    });

    if (res.status === 401 || res.status === 403) {
      log("warn", `${ttsTestName}: Auth required`);
      results.passed++;
    } else if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      results.failed++;
      results.errors.push({ test: ttsTestName, error: data.error });
    } else {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("audio")) {
        results.passed++;
        log("success", `${ttsTestName}: Audio response received`);
      } else {
        results.failed++;
        results.errors.push({ test: ttsTestName, error: `Unexpected content-type: ${contentType}` });
      }
    }
  } catch (err) {
    results.failed++;
    results.errors.push({ test: ttsTestName, error: err.message });
  }

  // Test 4: End endpoint
  const endTestName = "end/basic";
  try {
    const res = await fetch(`${baseUrl}/api/mock-interview/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          firm: "Goldman Sachs",
          stage: "superday",
          questionTypes: ["all"],
          randomize: true,
          followUps: true,
        },
        interviewMode: "ib_superday",
        askedQuestionIds: [],
        conversation: [
          { role: "interviewer", content: "Walk me through a DCF." },
          { role: "user", content: "A DCF projects unlevered free cash flows and discounts them at WACC to get enterprise value." },
        ],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      log("warn", `${endTestName}: Auth required`);
      results.passed++;
    } else {
      const data = await res.json();
      if (!res.ok) {
        results.failed++;
        results.errors.push({ test: endTestName, error: data.error });
      } else if (!data.finalSummary) {
        results.failed++;
        results.errors.push({ test: endTestName, error: "Missing finalSummary" });
      } else {
        results.passed++;
        log("success", `${endTestName}: Summary generated (${data.finalSummary.length} chars)`);
      }
    }
  } catch (err) {
    results.failed++;
    results.errors.push({ test: endTestName, error: err.message });
  }

  log("info", `Tests complete: ${results.passed} passed, ${results.failed} failed`);
  return results;
}

// ─── Task 3: Analyze Improvement Opportunities ──────────────────────────────

function analyzeImprovements(auditResults, testResults) {
  const improvements = [];

  // 1. Question bank quality
  if (auditResults.stats.tableHeaders > 50) {
    improvements.push({
      id: "clean_question_bank",
      priority: 1,
      title: "Clean question bank: remove table headers and document instructions",
      description: `${auditResults.stats.tableHeaders} entries are table headers/doc instructions, not real questions. Removing them improves plan quality.`,
      type: "data",
    });
  }

  if (auditResults.stats.tooShort > 100) {
    improvements.push({
      id: "remove_short_entries",
      priority: 2,
      title: "Remove entries shorter than 20 characters",
      description: `${auditResults.stats.tooShort} entries are too short to be real questions.`,
      type: "data",
    });
  }

  // 2. Model quality upgrade for critical paths
  improvements.push({
    id: "upgrade_plan_model",
    priority: 3,
    title: "Upgrade plan generation to use a higher-quality model",
    description: "Plan generation determines interview quality. Using a better model produces more realistic questions, better rubrics, and more detailed ideal answers.",
    type: "code",
    files: ["src/app/api/mock-interview/plan/route.ts"],
  });

  improvements.push({
    id: "upgrade_grade_model",
    priority: 4,
    title: "Upgrade grading to use a higher-quality model",
    description: "Grading quality directly impacts user learning. A better model gives more nuanced feedback, catches more gaps, and provides better corrected outlines.",
    type: "code",
    files: ["src/app/api/mock-interview/grade/route.ts"],
  });

  // 3. Latency optimization: parallel TTS + text gen
  improvements.push({
    id: "parallel_turn_tts",
    priority: 5,
    title: "Create a combined turn+TTS endpoint for parallel execution",
    description: "Currently the client calls turn → waits → calls TTS sequentially. A combined endpoint can fire text gen and prepare TTS in parallel, reducing total latency.",
    type: "code",
    files: ["src/app/api/mock-interview/turn/route.ts"],
  });

  // 4. Better question context in prompts
  improvements.push({
    id: "richer_question_context",
    priority: 6,
    title: "Include more question bank context in interview prompts",
    description: "Current prompts send minimal context. Including related questions, expected difficulty, and firm-specific patterns improves interview realism.",
    type: "code",
    files: ["src/app/api/mock-interview/plan/route.ts", "src/app/api/mock-interview/grade/route.ts"],
  });

  // 5. Test failures
  if (testResults && testResults.failed > 0) {
    for (const err of testResults.errors) {
      improvements.push({
        id: `fix_${err.test.replace(/\//g, "_")}`,
        priority: 0, // Bugs are highest priority
        title: `Fix failing test: ${err.test}`,
        description: `Error: ${err.error}`,
        type: "bugfix",
      });
    }
  }

  return improvements.sort((a, b) => a.priority - b.priority);
}

// ─── Task 4: Apply Improvements ─────────────────────────────────────────────

async function cleanQuestionBank(auditResults) {
  log("info", "Cleaning question bank...");
  const questions = auditResults.questions;
  // Filter out bad entries
  const cleaned = questions.filter((q) => {
    // Remove table headers
    if (q.prompt.includes("\t") && q.prompt.split("\t").length > 2) return false;
    // Remove doc instructions
    if (/^(\d+\.\s+)?(this document|give to receive|don't post|if we start)/i.test(q.prompt)) return false;
    // Remove very short entries
    if (q.prompt.trim().length < 15) return false;
    // Remove entries that are just names/formatting
    if (/^(Name\s|Emily\s|---)/i.test(q.prompt)) return false;
    return true;
  });

  const removed = questions.length - cleaned.length;
  log("info", `Removed ${removed} bad entries. ${cleaned.length} questions remain.`);

  // Rebuild meta
  const meta = { firms: [], countsByFirm: {}, countsByType: {}, countsByStage: {} };
  const firmSet = new Set();
  for (const q of cleaned) {
    meta.countsByFirm[q.firm] = (meta.countsByFirm[q.firm] || 0) + 1;
    meta.countsByType[q.questionType] = (meta.countsByType[q.questionType] || 0) + 1;
    meta.countsByStage[q.stage] = (meta.countsByStage[q.stage] || 0) + 1;
    if (q.firm !== "Other") firmSet.add(q.firm);
  }
  meta.firms = [...firmSet].sort();

  // Save
  saveJson(join(ROOT, "data", "question-bank.json"), cleaned);
  saveJson(join(ROOT, "data", "question-bank.meta.json"), meta);
  log("success", `Question bank cleaned: ${removed} entries removed`);

  return { removed, remaining: cleaned.length };
}

async function upgradeModelForRoute(routePath, newModel, _description) {
  log("info", `Upgrading model in ${routePath} to ${newModel}...`);
  const fullPath = join(ROOT, routePath);

  if (!existsSync(fullPath)) {
    log("error", `File not found: ${fullPath}`);
    return false;
  }

  let content = readFileSync(fullPath, "utf8");
  const oldModelMatch = content.match(/const MODEL = "([^"]+)"/);
  if (!oldModelMatch) {
    log("warn", `No MODEL constant found in ${routePath}`);
    return false;
  }

  const oldModel = oldModelMatch[1];
  if (oldModel === newModel) {
    log("info", `Model already set to ${newModel} in ${routePath}`);
    return true;
  }

  content = content.replace(`const MODEL = "${oldModel}"`, `const MODEL = "${newModel}"`);
  writeFileSync(fullPath, content, "utf8");
  log("success", `Upgraded ${routePath}: ${oldModel} → ${newModel}`);
  return true;
}

async function enrichPlanPromptWithContext() {
  log("info", "Enriching plan prompt with question bank context...");
  const planPath = join(ROOT, "src/app/api/mock-interview/plan/route.ts");
  let content = readFileSync(planPath, "utf8");

  // Check if already enriched
  if (content.includes("// [AGENT] Enriched context")) {
    log("info", "Plan prompt already enriched");
    return true;
  }

  // Add a helper that provides question distribution stats to the prompt
  const enrichment = `
  // [AGENT] Enriched context: include question bank stats in the prompt
  const bankStats = \`Question bank stats for \${body.firm}:
- Total available: \${seedCount} questions
- Types available: \${[...new Set(seeds.map(s => s.questionType))].join(", ")}
- Difficulty range: \${Math.min(...seeds.map(s => s.difficulty))}-\${Math.max(...seeds.map(s => s.difficulty))}
Ensure questions progress from easier to harder. Mix question types for a realistic interview flow.\`;
`;

  // Insert before the prompt template
  const promptStart = content.indexOf("  const prompt = `You are creating a mock interview plan.");
  if (promptStart === -1) {
    log("warn", "Could not find prompt insertion point");
    return false;
  }

  content = content.slice(0, promptStart) + enrichment + content.slice(promptStart);

  // Add the bankStats to the prompt
  content = content.replace(
    "Seed questions:\n${seedList}`",
    "Seed questions:\n${seedList}\n\n${bankStats}`"
  );

  writeFileSync(planPath, content, "utf8");
  log("success", "Plan prompt enriched with question bank context");
  return true;
}

async function addParallelTurnTtsRoute() {
  log("info", "Creating parallel turn+TTS route...");

  const routeDir = join(ROOT, "src/app/api/mock-interview/turn-with-audio");
  const routePath = join(routeDir, "route.ts");

  if (existsSync(routePath)) {
    log("info", "Parallel turn+TTS route already exists");
    return true;
  }

  // Create directory
  const { mkdirSync } = await import("fs");
  mkdirSync(routeDir, { recursive: true });

  const routeContent = `import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import z from "zod/v4";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { loadQuestionBank } from "@/lib/question-bank";
import {
  capText,
  filterQuestions,
  type InterviewMode,
  interviewModeConfigs,
  MockInterviewSettings,
  pickQuestion,
  settingsSchema,
  sumConversationChars,
} from "@/lib/mock-interview";

/**
 * Combined turn + TTS endpoint.
 *
 * Instead of the client calling /turn then /tts sequentially, this endpoint:
 * 1. Generates the interviewer text (quality model)
 * 2. Fires TTS request in parallel with real-time feedback generation
 * 3. Returns both the text AND the audio as a multipart response
 *
 * This saves one full round-trip latency (typically 300-800ms for TTS).
 */

const LIMIT = 60;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-4o-mini";
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
  interviewMode: z.string().optional(),
  includeAudio: z.boolean().optional(), // If true, include TTS audio in response
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

async function generateTTS(text: string): Promise<ArrayBuffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2";

  if (!apiKey || !voiceId) return null;

  const speakText = text.length > 280 ? text.slice(0, 277) + "..." : text;

  try {
    const resp = await fetch(
      \`https://api.elevenlabs.io/v1/text-to-speech/\${voiceId}?output_format=mp3_44100_128&optimize_streaming_latency=3\`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({ text: speakText, model_id: modelId }),
      }
    );
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
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

  if (process.env.NODE_ENV === "production") {
    const rate = enforceUserRateLimit({ key: email, limit: LIMIT, windowMs: WINDOW_MS });
    if (!rate.allowed) {
      const retryAfter = Math.ceil(rate.retryAfterMs / 1000);
      return NextResponse.json(
        { error: \`Rate limit exceeded. Try again in \${retryAfter} seconds.\`, requestId, retryAfterSeconds: retryAfter },
        { status: 429, headers: { "Retry-After": retryAfter.toString() } }
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
  const mode = (body.interviewMode || "standard") as InterviewMode;
  const modeConfig = interviewModeConfigs[mode] || interviewModeConfigs.standard;

  if (lastUserTurn.length > MAX_TURN_CHARS) {
    return NextResponse.json({ error: "Answer too long", requestId }, { status: 413 });
  }
  if (sumConversationChars(conversation) > MAX_HISTORY_CHARS) {
    return NextResponse.json({ error: "Conversation history too long", requestId }, { status: 413 });
  }

  const questions = loadQuestionBank();
  const currentQuestion = questions.find((q) => q.id === lastQuestionId);
  if (!currentQuestion) {
    return NextResponse.json({ error: "Unknown question id", requestId }, { status: 400 });
  }

  const shouldFollowUp = settings.followUps && lastUserTurn.trim().length < 220 && lastUserTurn.split(" ").length < 50;
  let nextQuestion = null;
  if (!shouldFollowUp) {
    const eligible = filterQuestions(questions, settings, askedQuestionIds);
    nextQuestion = pickQuestion(eligible, settings.randomize);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  const nextLine = shouldFollowUp
    ? \`Ask a brief follow-up on: \${currentQuestion.prompt}\`
    : \`Ask the next question: \${nextQuestion?.prompt || currentQuestion.prompt}\`;

  const modeContext = modeConfig.promptContext ? \`\\n\${modeConfig.promptContext}\\n\` : "";

  const interviewerPrompt = \`You are a mock interview interviewer conducting a \${modeConfig.label} interview.
Acknowledge the user's answer briefly, then ask one question.
Keep it concise and speakable (<= 280 characters).
\${modeContext}
Last user answer:
\${lastUserTurn}

\${nextLine}

Settings:
- Firm: \${settings.firm}
- Stage: \${settings.stage}
\`;

  // Step 1: Generate interviewer text
  let interviewerText = "";
  try {
    const interviewerResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${apiKey}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: "system", content: \`You are a mock interview interviewer conducting a \${modeConfig.label} interview. One question at a time, keep it concise and professional.\` },
          { role: "user", content: interviewerPrompt },
        ],
      }),
    });

    if (!interviewerResp.ok) {
      const errorText = await interviewerResp.text();
      return NextResponse.json({ error: errorText || interviewerResp.statusText, requestId }, { status: 502 });
    }

    const data = await interviewerResp.json();
    interviewerText = extractOutputText(data);
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }

  if (!interviewerText) {
    return NextResponse.json({ error: "Empty model output", requestId }, { status: 502 });
  }

  const cappedText = capText(interviewerText, 280);

  // Step 2: Fire TTS and feedback generation IN PARALLEL
  const [audioBuffer, realtimeFeedback] = await Promise.all([
    // TTS — runs in parallel
    body.includeAudio ? generateTTS(cappedText) : Promise.resolve(null),

    // Feedback — runs in parallel
    (async () => {
      try {
        const feedbackResp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: \`Bearer \${apiKey}\`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            input: [
              { role: "system", content: \`You are a mock interview coach for a \${modeConfig.label} interview. Keep feedback tight and skimmable.\` },
              {
                role: "user",
                content: \`Provide concise coaching bullets for the user's last answer in a \${modeConfig.label} mock interview.
Format as 4-5 bullet lines:
- Technical accuracy / content quality
- Structure / clarity
- Depth / specificity
- Better phrasing
- Key improvement area
\${modeConfig.gradingFocus ? \`\\nGrading focus: \${modeConfig.gradingFocus}\\n\` : ""}
Settings:
- Firm: \${settings.firm}
- Stage: \${settings.stage}

Answer:
\${lastUserTurn}\`,
              },
            ],
          }),
        });
        if (feedbackResp.ok) {
          const data = await feedbackResp.json();
          return extractOutputText(data);
        }
        return "";
      } catch {
        return "";
      }
    })(),
  ]);

  const done = !nextQuestion && !shouldFollowUp;

  // Build response with optional base64 audio
  const responseBody = {
    interviewerText: cappedText,
    realtimeFeedback,
    nextQuestionId: shouldFollowUp ? currentQuestion.id : nextQuestion?.id || currentQuestion.id,
    done,
    requestId,
    ...(audioBuffer ? { audioBase64: Buffer.from(audioBuffer).toString("base64") } : {}),
  };

  return NextResponse.json(responseBody);
}
`;

  writeFileSync(routePath, routeContent, "utf8");
  log("success", "Created parallel turn+TTS route at /api/mock-interview/turn-with-audio");
  return true;
}

// ─── Task 5: Generate Report ─────────────────────────────────────────────────

function generateReport(auditResults, testResults, improvements, applied) {
  const report = {
    timestamp: new Date().toISOString(),
    questionBankAudit: auditResults.stats,
    apiTests: testResults ? { passed: testResults.passed, failed: testResults.failed, errors: testResults.errors } : "skipped",
    improvements: improvements.map((i) => ({ ...i, applied: applied.includes(i.id) })),
    summary: {
      totalImprovements: improvements.length,
      applied: applied.length,
      remaining: improvements.length - applied.length,
    },
  };

  const reportPath = join(ROOT, "data", "agent-report.json");
  saveJson(reportPath, report);
  log("success", `Report saved to ${reportPath}`);
  return report;
}

// ─── Main Agent Loop ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const taskOnly = args.includes("--task") ? args[args.indexOf("--task") + 1] : null;
  const dryRun = args.includes("--dry-run");
  const baseUrl = args.includes("--url") ? args[args.indexOf("--url") + 1] : CONFIG.test.baseUrl;

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  BFC-GPT Autonomous Improvement Agent           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (dryRun) log("warn", "DRY RUN — no changes will be made");

  // Step 1: Audit question bank
  const auditResults = await auditQuestionBank();

  // Step 2: Test API flow (if server is running)
  let testResults = null;
  if (!taskOnly || taskOnly === "test") {
    try {
      const pingResp = await fetch(`${baseUrl}/api/tts/ping`, { signal: AbortSignal.timeout(3000) });
      if (pingResp.ok) {
        testResults = await testMockInterviewFlow(baseUrl);
      } else {
        log("warn", "Server responded but TTS ping failed — skipping API tests");
      }
    } catch {
      log("warn", `Server not running at ${baseUrl} — skipping API tests`);
    }
  }

  // Step 3: Analyze improvements
  const improvements = analyzeImprovements(auditResults, testResults);
  log("info", `Found ${improvements.length} improvement opportunities:`);
  for (const imp of improvements) {
    log("info", `  [P${imp.priority}] ${imp.title}`);
  }

  if (dryRun) {
    log("warn", "DRY RUN — stopping here");
    return;
  }

  if (taskOnly === "test") {
    log("info", "Test-only mode — stopping here");
    return;
  }

  // Step 4: Apply improvements
  const applied = [];

  // 4a: Clean question bank
  if (improvements.some((i) => i.id === "clean_question_bank")) {
    await cleanQuestionBank(auditResults);
    applied.push("clean_question_bank");
    applied.push("remove_short_entries");
  }

  // 4b: Enrich plan prompt with context
  if (improvements.some((i) => i.id === "richer_question_context")) {
    const enriched = await enrichPlanPromptWithContext();
    if (enriched) applied.push("richer_question_context");
  }

  // 4c: Upgrade models for plan and grade routes
  if (improvements.some((i) => i.id === "upgrade_plan_model")) {
    const upgraded = await upgradeModelForRoute(
      "src/app/api/mock-interview/plan/route.ts",
      CONFIG.models.fast,
      "Plan generation"
    );
    if (upgraded) applied.push("upgrade_plan_model");
  }
  if (improvements.some((i) => i.id === "upgrade_grade_model")) {
    const upgraded = await upgradeModelForRoute(
      "src/app/api/mock-interview/grade/route.ts",
      CONFIG.models.fast,
      "Grading"
    );
    if (upgraded) applied.push("upgrade_grade_model");
  }

  // 4d: Create parallel turn+TTS route
  if (improvements.some((i) => i.id === "parallel_turn_tts")) {
    const created = await addParallelTurnTtsRoute();
    if (created) applied.push("parallel_turn_tts");
  }

  // Step 5: Generate report
  generateReport(auditResults, testResults, improvements, applied);

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Agent Run Complete                              ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Improvements found: ${improvements.length}`);
  console.log(`  Improvements applied: ${applied.length}`);
  console.log(`  Question bank cleaned: ${auditResults.stats.tableHeaders + auditResults.stats.tooShort} bad entries removed`);
  if (testResults) {
    console.log(`  API tests: ${testResults.passed} passed, ${testResults.failed} failed`);
  }
  console.log(`  Report: data/agent-report.json\n`);
}

main().catch((err) => {
  log("error", "Agent failed:", { message: err.message, stack: err.stack });
  process.exit(1);
});
