import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/auth";
import PracticeClient from "./practice-client";

export default async function PracticePage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");
  return <PracticeClient />;
}
