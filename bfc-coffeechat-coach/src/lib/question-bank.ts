import fs from "fs";
import path from "path";

export type QuestionStage =
  | "coffee_chat"
  | "hirevue"
  | "first_round"
  | "second_round"
  | "superday"
  | "unknown";

export type QuestionType =
  | "behavioral"
  | "accounting"
  | "valuation"
  | "lbo"
  | "merger_math"
  | "market"
  | "brainteaser"
  | "other";

export type QuestionRecord = {
  id: string;
  firm: string;
  group: string;
  stage: QuestionStage;
  questionType: QuestionType;
  difficulty: 1 | 2 | 3;
  prompt: string;
  notes: string;
  source: string;
};

export type QuestionBankMeta = {
  firms: string[];
  countsByFirm: Record<string, number>;
  countsByType: Record<string, number>;
  countsByStage: Record<string, number>;
};

let cachedQuestions: QuestionRecord[] | null = null;
let cachedMeta: QuestionBankMeta | null = null;

function readJson<T>(filePath: string): T {
  const data = fs.readFileSync(filePath, "utf8");
  return JSON.parse(data) as T;
}

export function loadQuestionBank() {
  if (cachedQuestions) return cachedQuestions;
  const filePath = path.join(process.cwd(), "data", "question-bank.json");
  cachedQuestions = readJson<QuestionRecord[]>(filePath);
  return cachedQuestions;
}

export function loadQuestionBankMeta() {
  if (cachedMeta) return cachedMeta;
  const filePath = path.join(process.cwd(), "data", "question-bank.meta.json");
  cachedMeta = readJson<QuestionBankMeta>(filePath);
  return cachedMeta;
}
