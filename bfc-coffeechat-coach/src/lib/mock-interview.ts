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
