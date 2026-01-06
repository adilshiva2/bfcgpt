"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const steps = [
  {
    title: "Speak naturally",
    copy: "Voice + live transcript keeps the conversation flowing.",
  },
  {
    title: "Get real-time coaching",
    copy: "Tone, structure, and referral readiness update instantly.",
  },
  {
    title: "Improve with follow-ups",
    copy: "Next best questions and summaries sharpen your approach.",
  },
];

const coachingTips = [
  "Tone: warm and concise. Good rapport.",
  "Clarity: tighten your story in 20 seconds.",
  "Referral readiness: building — ask 1 more question first.",
];


export default function Home() {
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % coachingTips.length);
    }, 3200);
    return () => clearInterval(interval);
  }, []);

  const currentTip = useMemo(() => coachingTips[tipIndex], [tipIndex]);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-16 px-6 pb-20 pt-16">
      <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div className="space-y-6">
          <Badge className="w-fit" tone="neutral">
            Berkeley Finance Club
          </Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 sm:text-5xl">
            ChatBFC
          </h1>
          <p className="max-w-xl text-lg text-slate-700 dark:text-slate-200">
            Practice finance conversations with an AI interviewer. Get coached. Win referrals.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/practice">
              <Button type="button">Start Coffee Chat</Button>
            </Link>
            <Link href="/mock-interview">
              <Button variant="secondary" type="button">
                Mock Interview
              </Button>
            </Link>
          </div>
        </div>
        <Card className="overflow-hidden border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-100 px-6 py-4 text-sm font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-50">
            Live Coaching
          </div>
          <div className="space-y-4 px-6 py-6">
            <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
              <span>Interviewer</span>
              <span className="font-medium text-slate-900 dark:text-slate-100">IB Analyst • TMT</span>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-200">
              “Walk me through your story and why this group.”
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="warning">Structure</Badge>
              <Badge tone="success">Tone</Badge>
              <Badge>Referral Path</Badge>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Coaching Tip
              </div>
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentTip}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.25 }}
                  className="mt-2 font-medium"
                >
                  {currentTip}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </Card>
      </section>

      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Modes</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Pick the experience that matches your current prep.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="flex h-full flex-col gap-4 border-slate-200 p-6 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Coffee Chats</h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                Voice-based mock coffee chats with realistic pacing.
              </p>
            </div>
            <ul className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
              <li>• Live transcript</li>
              <li>• Realtime coaching</li>
              <li>• Referral-focused</li>
            </ul>
            <Link href="/practice" className="mt-auto">
              <Button type="button">Start Coffee Chat</Button>
            </Link>
          </Card>
          <Card className="flex h-full flex-col gap-4 border-slate-200 p-6 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Mock Interviews</h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                Firm + question-type driven practice using the internal question bank.
              </p>
            </div>
            <ul className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
              <li>• Firm-specific questions</li>
              <li>• Realtime feedback</li>
              <li>• Next best question</li>
            </ul>
            <Link href="/mock-interview" className="mt-auto">
              <Button variant="secondary" type="button">
                Start Mock Interview
              </Button>
            </Link>
          </Card>
        </div>
      </section>

      <section id="how-it-works" className="space-y-8">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">How it Works</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            A tight loop for confident finance conversations.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => (
            <Card key={step.title} className="p-6 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-50">
                {index + 1}
              </div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">{step.title}</h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{step.copy}</p>
            </Card>
          ))}
        </div>
      </section>

      <footer className="flex flex-col items-start gap-2 border-t border-slate-200 pt-6 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <span>Built for Berkeley Finance Club</span>
      </footer>
    </main>
  );
}
