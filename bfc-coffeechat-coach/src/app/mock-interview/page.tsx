import { loadQuestionBankMeta } from "@/lib/question-bank";
import MockInterviewClient from "./mock-interview-client";

export default function MockInterviewPage() {
  const meta = loadQuestionBankMeta();
  return <MockInterviewClient meta={meta} />;
}
