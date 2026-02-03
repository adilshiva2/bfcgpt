import z from "zod/v4";
import type { QuestionRecord, QuestionStage, QuestionType } from "@/lib/question-bank";

const allowedStages = ["first_round", "second_round", "superday"] as const;

export const stageSchema = z.preprocess(
  (value: unknown) => {
    if (typeof value !== "string") return "first_round";
    if (allowedStages.includes(value as (typeof allowedStages)[number])) {
      return value;
    }
    return "first_round";
  },
  z.enum(allowedStages)
);

export const questionTypeSchema = z.enum([
  "behavioral",
  "accounting",
  "valuation",
  "lbo",
  "merger_math",
  "market",
  "brainteaser",
  "other",
]);

export const settingsSchema = z.object({
  firm: z.string(),
  stage: stageSchema,
  questionTypes: z.array(z.union([questionTypeSchema, z.literal("all")])),
  randomize: z.boolean(),
  followUps: z.boolean(),
}).passthrough();

export type MockInterviewSettings = z.infer<typeof settingsSchema>;

export type ConversationMessage = {
  role: "interviewer" | "user";
  content: string;
};

export function filterQuestions(
  questions: QuestionRecord[],
  settings: MockInterviewSettings,
  askedIds: string[] = []
) {
  const questionTypes =
    settings.questionTypes.length === 0 || settings.questionTypes.includes("all")
      ? questionTypeOptions
      : settings.questionTypes;
  return questions.filter((question) => {
    if (settings.firm && settings.firm !== "All" && question.firm !== settings.firm) {
      return false;
    }
    if (question.stage !== settings.stage) {
      return false;
    }
    if (questionTypes.length > 0 && !questionTypes.includes(question.questionType)) {
      return false;
    }
    if (askedIds.length > 0 && askedIds.includes(question.id)) {
      return false;
    }
    return true;
  });
}

export function pickQuestion(questions: QuestionRecord[], randomize: boolean) {
  if (questions.length === 0) return null;
  if (!randomize) return questions[0];
  const idx = Math.floor(Math.random() * questions.length);
  return questions[idx] || questions[0];
}

export function capText(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

export function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function sumConversationChars(conversation: ConversationMessage[]) {
  return conversation.reduce((sum, msg) => sum + msg.content.length, 0);
}

export const questionStageOptions: QuestionStage[] = [
  "first_round",
  "second_round",
  "superday",
];

export const questionTypeOptions: QuestionType[] = [
  "behavioral",
  "accounting",
  "valuation",
  "lbo",
  "merger_math",
  "market",
  "brainteaser",
  "other",
];

/* ------------------------------------------------------------------ */
/*  Interview modes – IB, PE, HF with round-specific configs          */
/* ------------------------------------------------------------------ */

export type InterviewMode =
  | "standard"
  | "ib_first_round"
  | "ib_superday"
  | "pe_interview"
  | "hf_interview";

export type InterviewModeConfig = {
  label: string;
  description: string;
  suggestedTypes: QuestionType[];
  promptContext: string;
  defaultNumQuestions: number;
  pressureLevel: "low" | "medium" | "high";
  gradingFocus: string;
};

export const interviewModeConfigs: Record<InterviewMode, InterviewModeConfig> = {
  standard: {
    label: "Standard Mix",
    description: "Balanced mix of all question types",
    suggestedTypes: ["behavioral", "accounting", "valuation", "market"],
    promptContext: "",
    defaultNumQuestions: 6,
    pressureLevel: "low",
    gradingFocus: "",
  },
  ib_first_round: {
    label: "IB First Round",
    description: "Behavioral-heavy with basic technicals and fit focus",
    suggestedTypes: ["behavioral", "accounting", "valuation"],
    promptContext: `This is a first-round investment banking interview. The interviewer is typically an analyst or associate.
Focus on: 'Walk me through your resume', 'Why investment banking?', 'Why this firm?', basic accounting (3-statement model walkthrough), and simple valuation concepts.
Tone: Professional but conversational. Give the candidate a chance to build rapport.
Follow-up style: Probe for specificity on deal experience, motivation, and cultural fit.`,
    defaultNumQuestions: 6,
    pressureLevel: "medium",
    gradingFocus:
      "Grade behavioral answers using STAR method (Situation, Task, Action, Result). For technicals, accept directionally correct answers with clear reasoning.",
  },
  ib_superday: {
    label: "IB Superday",
    description: "Rapid-fire technicals: accounting, valuation, LBO, M&A",
    suggestedTypes: ["accounting", "valuation", "lbo", "merger_math", "brainteaser"],
    promptContext: `This is an investment banking superday interview. The interviewer is a VP or MD.
Focus on: Deep technical questions – 3-statement modeling, enterprise vs equity value, DCF mechanics, LBO structure, accretion/dilution, merger math.
Tone: Direct and time-pressured. Expect precise, structured answers. Push back on vague responses.
Follow-up style: Drill into mechanics. 'Walk me through the exact steps' or 'What if X changed?'
Pace: Move quickly between questions. If the candidate struggles, give a brief hint then move on.`,
    defaultNumQuestions: 10,
    pressureLevel: "high",
    gradingFocus:
      "Grade technical accuracy strictly. Partial credit for correct framework even if numbers are wrong. Deduct for hand-waving or 'it depends' without follow-through.",
  },
  pe_interview: {
    label: "PE Interview",
    description: "Deal deep-dives, LBO mechanics, value creation, portfolio ops",
    suggestedTypes: ["behavioral", "lbo", "valuation", "market", "other"],
    promptContext: `This is a private equity interview. The interviewer is a principal or partner.
Focus on: Specific deal experience ('Walk me through a deal you worked on'), LBO mechanics and value creation levers (revenue growth, margin expansion, multiple expansion, debt paydown), portfolio company operations, and investment thesis development.
Tone: Intellectually rigorous. Test whether the candidate thinks like an investor, not just a banker.
Follow-up style: Challenge assumptions. 'What risks would you flag?' and 'How would you create value post-acquisition?'
Key questions: 'Pitch me a company', 'Walk me through an LBO', 'What makes a good PE investment?'`,
    defaultNumQuestions: 8,
    pressureLevel: "high",
    gradingFocus:
      "Grade on investment thinking depth. Strong answers demonstrate understanding of value creation, risk assessment, and operational improvement. Penalize pure banking-speak without investor lens.",
  },
  hf_interview: {
    label: "HF Interview",
    description: "Stock pitches, market views, brainteasers, conviction testing",
    suggestedTypes: ["market", "brainteaser", "valuation", "other"],
    promptContext: `This is a hedge fund interview. The interviewer is a portfolio manager or senior analyst.
Focus on: 'Pitch me a stock' (long or short), market analysis and macro views, mental math, brain teasers, and analytical reasoning.
Tone: Skeptical and challenging. Push back on every thesis. Test conviction and ability to defend ideas under pressure.
Follow-up style: Play devil's advocate. 'What's the bear case?', 'What's your catalyst?', 'What if the market disagrees?'
Key questions: Stock pitches (must include thesis, valuation, catalyst, risks), market views, probability/expected value questions.`,
    defaultNumQuestions: 8,
    pressureLevel: "high",
    gradingFocus:
      "Grade on conviction, analytical rigor, and ability to defend under pressure. Strong pitches have clear thesis, quantified valuation, identified catalyst, and honest risk assessment. Penalize wishy-washy answers.",
  },
};

export const interviewModeOptions = Object.entries(interviewModeConfigs).map(
  ([value, config]) => ({ value: value as InterviewMode, label: config.label })
);
