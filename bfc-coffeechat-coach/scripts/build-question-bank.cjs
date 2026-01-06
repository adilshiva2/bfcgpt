/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const SOURCE_PDF = path.join(__dirname, "..", "data", "source", "interview-question-bank.pdf");
const OUTPUT_JSON = path.join(__dirname, "..", "data", "question-bank.json");
const OUTPUT_META = path.join(__dirname, "..", "data", "question-bank.meta.json");
const MANUAL_JSON = path.join(__dirname, "..", "data", "question-bank.manual.json");
const ALLOWLIST_JSON = path.join(__dirname, "..", "data", "firm-allowlist.json");
const ALIASES_JSON = path.join(__dirname, "..", "data", "firm-aliases.json");

function isFirmHeading(line) {
  if (!line) return false;
  if (line.length > 40) return false;
  if (line.includes("?")) return false;
  if (/^[A-Z0-9 &.'-]+$/.test(line)) return true;
  return /^[A-Z][a-zA-Z&.'-]+(?:\s+[A-Z][a-zA-Z&.'-]+)*$/.test(line);
}

function normalizeQuestion(line) {
  return line.replace(/^[-•]\s*/, "").trim();
}

function questionTypeFor(text) {
  const lower = text.toLowerCase();
  if (/(lbo|leveraged buyout)/.test(lower)) return "lbo";
  if (/(accretion|dilution|merger)/.test(lower)) return "merger_math";
  if (/(valuation|dcf|comps|precedent|multiples)/.test(lower)) return "valuation";
  if (/(accounting|balance sheet|income statement|cash flow)/.test(lower)) return "accounting";
  if (/(market|macro|rates|fed|inflation)/.test(lower)) return "market";
  if (/(brainteaser|puzzle|estimate)/.test(lower)) return "brainteaser";
  if (/(tell me about yourself|strength|weakness|leadership|conflict|behavior)/.test(lower)) {
    return "behavioral";
  }
  return "other";
}

function difficultyFor(text) {
  const lower = text.toLowerCase();
  if (/(lbo|accretion|dilution|leveraged|merger math)/.test(lower)) return 3;
  if (/(valuation|dcf|comps|accounting|cash flow)/.test(lower)) return 2;
  return 1;
}

function stageFor(text) {
  const lower = text.toLowerCase();
  if (lower.includes("superday")) return "superday";
  if (lower.includes("second round")) return "second_round";
  if (lower.includes("first round")) return "first_round";
  if (lower.includes("hirevue")) return "hirevue";
  if (lower.includes("coffee chat")) return "coffee_chat";
  return "unknown";
}

function buildMeta(records) {
  const firms = Array.from(
    new Set(records.map((r) => r.firm).filter((firm) => firm !== "Other"))
  ).sort();
  const countsByFirm = {};
  const countsByType = {};
  const countsByStage = {};
  for (const record of records) {
    countsByFirm[record.firm] = (countsByFirm[record.firm] || 0) + 1;
    countsByType[record.questionType] = (countsByType[record.questionType] || 0) + 1;
    countsByStage[record.stage] = (countsByStage[record.stage] || 0) + 1;
  }
  return { firms, countsByFirm, countsByType, countsByStage };
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_JSON)) return [];
  return JSON.parse(fs.readFileSync(ALLOWLIST_JSON, "utf8"));
}

function loadAliases() {
  if (!fs.existsSync(ALIASES_JSON)) return {};
  return JSON.parse(fs.readFileSync(ALIASES_JSON, "utf8"));
}

function normalizeFirm(rawFirm, allowlistMap, aliases) {
  const cleaned = rawFirm.replace(/\s{2,}/g, " ").trim();
  const lower = cleaned.toLowerCase();
  const alias = aliases[lower];
  if (alias && allowlistMap.has(alias.toLowerCase())) {
    return allowlistMap.get(alias.toLowerCase());
  }
  if (allowlistMap.has(lower)) {
    return allowlistMap.get(lower);
  }
  return "Other";
}

function mergeManual(records, manualRecords) {
  if (!Array.isArray(manualRecords) || manualRecords.length === 0) return records;
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const manual of manualRecords) {
    if (!manual?.id) continue;
    byId.set(manual.id, manual);
  }
  return Array.from(byId.values());
}

async function buildQuestionBank() {
  if (!fs.existsSync(SOURCE_PDF)) {
    throw new Error(`Missing PDF at ${SOURCE_PDF}`);
  }

  const pdfBuffer = fs.readFileSync(SOURCE_PDF);
  const parser = new PDFParse({ data: pdfBuffer });
  const pdfData = await parser.getText();
  const lines = pdfData.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const allowlist = loadAllowlist();
  const allowlistMap = new Map(
    allowlist.map((firm) => [firm.toLowerCase(), firm])
  );
  const aliases = loadAliases();

  let currentFirm = "Unknown";
  const questions = [];
  const perFirmCount = {};

  for (const line of lines) {
    if (isFirmHeading(line)) {
      currentFirm = line.replace(/\s{2,}/g, " ").trim();
      if (!perFirmCount[currentFirm]) perFirmCount[currentFirm] = 0;
      continue;
    }

    const cleaned = normalizeQuestion(line);
    if (!cleaned) continue;
    const looksLikeQuestion = cleaned.endsWith("?") || cleaned.length > 15;
    if (!looksLikeQuestion) continue;

    const normalizedFirm = normalizeFirm(currentFirm, allowlistMap, aliases);
    const idx = (perFirmCount[currentFirm] = (perFirmCount[currentFirm] || 0) + 1);
    const id = `${normalizedFirm.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${idx}`;
    const stage = stageFor(cleaned);
    questions.push({
      id,
      firm: normalizedFirm,
      group: "unknown",
      stage,
      questionType: questionTypeFor(cleaned),
      difficulty: difficultyFor(cleaned),
      prompt: cleaned,
      notes: "",
      source: "interview-question-bank.pdf",
    });
  }

  let merged = questions;
  if (fs.existsSync(MANUAL_JSON)) {
    const manual = JSON.parse(fs.readFileSync(MANUAL_JSON, "utf8"));
    merged = mergeManual(questions, manual);
  }

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(merged, null, 2));
  const meta = buildMeta(merged);
  fs.writeFileSync(OUTPUT_META, JSON.stringify(meta, null, 2));

  console.log(`Generated ${merged.length} questions across ${meta.firms.length} firms.`);
}

buildQuestionBank().catch((err) => {
  console.error(err);
  process.exit(1);
});
