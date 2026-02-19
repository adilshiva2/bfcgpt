#!/usr/bin/env node
/**
 * Continuous Mock Interview Test Loop
 *
 * Runs the full mock interview workflow in a loop, testing:
 * 1. Plan generation (POST /api/mock-interview/plan)
 * 2. Grading (POST /api/mock-interview/grade)
 * 3. End summary (POST /api/mock-interview/end)
 * 4. TTS (POST /api/tts)
 *
 * If a test fails, it logs the full error with diagnostics.
 * Runs until manually stopped (Ctrl+C) or until --max-runs is reached.
 *
 * Usage:
 *   node scripts/test-loop.mjs                          # Run against localhost:3000
 *   node scripts/test-loop.mjs --url https://bfcgpt.vercel.app  # Test production
 *   node scripts/test-loop.mjs --max-runs 5             # Stop after 5 runs
 *   node scripts/test-loop.mjs --interval 30            # 30 seconds between runs
 */

const BASE_URL = getArg("--url") || "http://localhost:3000";
const MAX_RUNS = parseInt(getArg("--max-runs") || "0", 10); // 0 = infinite
const INTERVAL_SEC = parseInt(getArg("--interval") || "60", 10);

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const FIRMS = ["Goldman Sachs", "Evercore", "Lazard", "Centerview", "All"];
const MODES = ["standard", "ib_first_round", "ib_superday", "pe_interview", "hf_interview"];
const STAGES = ["first_round", "superday"];

const SAMPLE_ANSWERS = {
  valuation: "A DCF values a company by projecting unlevered free cash flows over a 5-10 year period, then discounting them back to present value using WACC. You start with revenue, work down to EBIT, subtract taxes, add back D&A, subtract capex and changes in working capital to get UFCF. Terminal value is calculated using either a perpetuity growth method or exit multiple. Enterprise value equals the sum of discounted FCFs plus discounted terminal value.",
  behavioral: "During my summer internship at a boutique advisory firm, I was tasked with building a comparable company analysis for a healthcare client on a tight 48-hour deadline. The challenge was that the client operated in a niche sub-sector with few direct comparables. I expanded the peer set by identifying companies with similar margin profiles and growth characteristics across adjacent sectors, then created adjustment factors. The result was a robust valuation range that the senior banker presented directly to the client.",
  lbo: "In a leveraged buyout, a PE firm acquires a company using a significant amount of debt, typically 60-70% of the purchase price. The key value creation levers are: revenue growth, margin expansion through operational improvements, debt paydown using free cash flow, and multiple expansion at exit. Returns are measured by IRR and MOIC. A typical target has stable cash flows, low capex requirements, and defensible market position.",
  accounting: "When you increase depreciation by $10, operating income decreases by $10. Net income decreases by $10 times (1 minus the tax rate), so $6 assuming 40% taxes. On the cash flow statement, net income is down $6 but D&A is added back at $10, so cash from operations increases by $4. On the balance sheet, PP&E decreases by $10 and cash increases by $4, with retained earnings down $6.",
  other: "I believe the most important quality in investment banking is attention to detail combined with the ability to work under pressure. In my experience building financial models, I've learned that small errors can compound significantly, so I always double-check my work and create error-checking mechanisms in my spreadsheets.",
};

let totalRuns = 0;
let totalPassed = 0;
let totalFailed = 0;

function log(level, msg, data) {
  const ts = new Date().toISOString().slice(11, 19);
  const colors = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", ok: "\x1b[32m", dim: "\x1b[90m" };
  const reset = "\x1b[0m";
  const c = colors[level] || "";
  console.log(`${colors.dim}${ts}${reset} ${c}[${level.toUpperCase()}]${reset} ${msg}`);
  if (data) console.log(`${colors.dim}${JSON.stringify(data, null, 2)}${reset}`);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function testPlan(firm, mode, stage) {
  const label = `plan/${firm}/${mode}/${stage}`;
  try {
    const res = await fetch(`${BASE_URL}/api/mock-interview/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firm,
        stage,
        questionTypes: ["all"],
        numQuestions: 4,
        randomize: true,
        interviewMode: mode,
      }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }

    if (res.status === 401 || res.status === 403) {
      log("warn", `${label}: Auth required (expected for authenticated endpoints)`);
      return { ok: true, auth: true, label };
    }

    if (res.status === 404) {
      log("warn", `${label}: No questions found for ${firm}/${stage}`);
      return { ok: true, noQuestions: true, label };
    }

    if (!res.ok) {
      log("error", `${label}: HTTP ${res.status}`, data);
      return { ok: false, label, status: res.status, error: data.error || text.slice(0, 200) };
    }

    if (!data.plan || !Array.isArray(data.plan) || data.plan.length === 0) {
      log("error", `${label}: Missing or empty plan array`, data);
      return { ok: false, label, error: "No plan items returned" };
    }

    // Validate each plan item has required fields
    for (const item of data.plan) {
      if (!item.interviewerQuestion) {
        log("error", `${label}: Plan item missing interviewerQuestion`, item);
        return { ok: false, label, error: "Plan item missing interviewerQuestion" };
      }
    }

    log("ok", `${label}: ${data.plan.length} questions, seed count: ${data.seedCount}`);
    return { ok: true, label, plan: data.plan };
  } catch (err) {
    log("error", `${label}: ${err.message}`);
    return { ok: false, label, error: err.message };
  }
}

async function testGrade(planItem, firm, mode) {
  const label = `grade/${planItem.type}`;
  const answer = SAMPLE_ANSWERS[planItem.type] || SAMPLE_ANSWERS.other;
  try {
    const res = await fetch(`${BASE_URL}/api/mock-interview/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planItem,
        userAnswer: answer,
        firm,
        stage: "superday",
        interviewMode: mode,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      log("warn", `${label}: Auth required`);
      return { ok: true, auth: true, label };
    }

    const data = await res.json();
    if (!res.ok) {
      log("error", `${label}: HTTP ${res.status}`, data);
      return { ok: false, label, error: data.error };
    }

    if (typeof data.score0to10 !== "number") {
      log("error", `${label}: Missing score`, data);
      return { ok: false, label, error: "Missing score0to10" };
    }

    log("ok", `${label}: Score ${data.score0to10}/10, ${data.strengths?.length || 0} strengths, ${data.gaps?.length || 0} gaps`);
    return { ok: true, label, score: data.score0to10 };
  } catch (err) {
    log("error", `${label}: ${err.message}`);
    return { ok: false, label, error: err.message };
  }
}

async function testEnd(firm, mode) {
  const label = `end/${firm}/${mode}`;
  try {
    const res = await fetch(`${BASE_URL}/api/mock-interview/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: { firm, stage: "superday", questionTypes: ["all"], randomize: true, followUps: true },
        interviewMode: mode,
        askedQuestionIds: [],
        conversation: [
          { role: "interviewer", content: "Walk me through a DCF analysis." },
          { role: "user", content: SAMPLE_ANSWERS.valuation },
          { role: "interviewer", content: "Good. Now walk me through an LBO." },
          { role: "user", content: SAMPLE_ANSWERS.lbo },
        ],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      log("warn", `${label}: Auth required`);
      return { ok: true, auth: true, label };
    }

    const data = await res.json();
    if (!res.ok) {
      log("error", `${label}: HTTP ${res.status}`, data);
      return { ok: false, label, error: data.error };
    }

    if (!data.finalSummary) {
      log("error", `${label}: Missing finalSummary`);
      return { ok: false, label, error: "No summary returned" };
    }

    log("ok", `${label}: Summary ${data.finalSummary.length} chars`);
    return { ok: true, label };
  } catch (err) {
    log("error", `${label}: ${err.message}`);
    return { ok: false, label, error: err.message };
  }
}

async function testTts() {
  const label = "tts";
  try {
    const res = await fetch(`${BASE_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Walk me through your resume." }),
    });

    if (res.status === 401 || res.status === 403) {
      log("warn", `${label}: Auth required`);
      return { ok: true, auth: true, label };
    }

    if (!res.ok) {
      const text = await res.text();
      log("error", `${label}: HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, label, error: text.slice(0, 200) };
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("audio")) {
      log("error", `${label}: Expected audio, got ${ct}`);
      return { ok: false, label, error: `Wrong content-type: ${ct}` };
    }

    log("ok", `${label}: Audio received`);
    return { ok: true, label };
  } catch (err) {
    log("error", `${label}: ${err.message}`);
    return { ok: false, label, error: err.message };
  }
}

async function runOnce() {
  totalRuns++;
  const firm = pick(FIRMS);
  const mode = pick(MODES);
  const stage = pick(STAGES);

  console.log(`\n${"─".repeat(60)}`);
  log("info", `Run #${totalRuns} — ${firm} / ${mode} / ${stage}`);
  console.log(`${"─".repeat(60)}`);

  const results = [];

  // Test 1: Plan
  const planResult = await testPlan(firm, mode, stage);
  results.push(planResult);

  // Test 2: Grade (only if plan succeeded with items)
  if (planResult.ok && planResult.plan && planResult.plan.length > 0) {
    const gradeResult = await testGrade(planResult.plan[0], firm, mode);
    results.push(gradeResult);
  }

  // Test 3: End
  const endResult = await testEnd(firm, mode);
  results.push(endResult);

  // Test 4: TTS
  const ttsResult = await testTts();
  results.push(ttsResult);

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  totalPassed += passed;
  totalFailed += failed;

  log("info", `Run #${totalRuns}: ${passed} passed, ${failed} failed (cumulative: ${totalPassed}/${totalPassed + totalFailed})`);

  return { passed, failed, results };
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  BFC-GPT Continuous Test Loop                    ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Max runs: ${MAX_RUNS || "infinite"}`);
  console.log(`  Interval: ${INTERVAL_SEC}s\n`);

  // Check server is reachable
  try {
    await fetch(`${BASE_URL}/api/tts/ping`, { signal: AbortSignal.timeout(5000) });
    log("ok", "Server is reachable");
  } catch {
    log("error", `Server not reachable at ${BASE_URL}`);
    log("info", "Start the dev server first: npm run dev");
    process.exit(1);
  }

  while (true) {
    await runOnce();

    if (MAX_RUNS > 0 && totalRuns >= MAX_RUNS) {
      break;
    }

    log("dim", `Waiting ${INTERVAL_SEC}s before next run... (Ctrl+C to stop)`);
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Final: ${totalPassed} passed, ${totalFailed} failed across ${totalRuns} runs`);
  console.log(`${"═".repeat(60)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  log("error", `Test loop crashed: ${err.message}`);
  process.exit(1);
});
