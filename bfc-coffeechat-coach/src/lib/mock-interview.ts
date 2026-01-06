import z from "zod/v4";
import type { QuestionRecord, QuestionStage, QuestionType } from "@/lib/question-bank";

export const stageSchema = z.enum([
  "coffee_chat",
  "hirevue",
  "first_round",
  "second_round",
  "superday",
  "unknown",
  "all",
]);

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
  difficulty: z.union([z.literal("any"), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  randomize: z.boolean(),
  followUps: z.boolean(),
});

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
  const questionTypes = settings.questionTypes.includes("all")
    ? questionTypeOptions
    : settings.questionTypes;
  return questions.filter((question) => {
    if (settings.firm && settings.firm !== "All" && question.firm !== settings.firm) {
      return false;
    }
    if (settings.stage !== "all" && question.stage !== settings.stage) {
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
  "coffee_chat",
  "hirevue",
  "first_round",
  "second_round",
  "superday",
  "unknown",
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
