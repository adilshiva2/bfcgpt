"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const features = [
  {
    title: "Scenario Library",
    description: "Targeted prompts by track, group, and interviewer vibe.",
  },
  {
    title: "Coaching Panel",
    description: "Structured feedback with next-best-question guidance.",
  },
  {
    title: "Referral Ask Trainer",
    description: "Practice timing and phrasing for confident referral asks.",
  },
  {
    title: "Notes",
    description: "Capture insights after each session.",
    soon: true,
  },
];

const steps = [
  {
    title: "Pick a scenario",
    copy: "Choose track, firm type, and interviewer vibe.",
  },
  {
    title: "Run the chat",
    copy: "Speak naturally while the agent roleplays.",
  },
  {
    title: "Improve fast",
    copy: "Review coaching and repeat with higher stakes.",
  },
];

const containerVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.12 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
};

export default function Home() {
  const primaryCta =
    "inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900";
  const secondaryCta =
    "inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900";

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
            Practice coffee chats. Get real feedback. Win referrals.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/practice" className={primaryCta}>
              <motion.span whileHover={{ y: -1 }} whileTap={{ scale: 0.98 }}>
                Start Practice
              </motion.span>
            </Link>
            <Link href="/#how-it-works" className={secondaryCta}>
              <motion.span
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.98 }}
              >
                How it Works
              </motion.span>
            </Link>
          </div>
        </div>
        <Card className="overflow-hidden border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-6 py-4 text-sm font-semibold text-slate-900">
            Live session snapshot
          </div>
          <div className="space-y-4 px-6 py-6">
            <div className="flex items-center justify-between text-sm text-slate-600">
              <span>Interviewer</span>
              <span className="font-medium text-slate-900">IB Analyst • TMT</span>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-700">
              “Walk me through your story and why this group.”
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="warning">Structure</Badge>
              <Badge tone="success">Tone</Badge>
              <Badge>Referral Path</Badge>
            </div>
            <div className="text-sm text-slate-700">
              Next best question: <span className="font-semibold text-slate-900">Ask for role-specific
              advice.</span>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          className="grid gap-4 md:grid-cols-2"
        >
          {features.map((feature) => (
            <motion.div key={feature.title} variants={itemVariants}>
              <Card className="flex h-full flex-col gap-3 border-slate-200 p-6 transition-shadow hover:shadow-md">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">{feature.title}</h3>
                  {feature.soon ? <Badge tone="warning">Coming soon</Badge> : null}
                </div>
                <p className="text-sm text-slate-700">{feature.description}</p>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <section id="how-it-works" className="space-y-8">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">How it Works</h2>
          <p className="mt-2 text-sm text-slate-600">
            A tighter loop for coffee chat mastery.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => (
            <Card key={step.title} className="p-6">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-sm font-semibold text-slate-900">
                {index + 1}
              </div>
              <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{step.copy}</p>
            </Card>
          ))}
        </div>
      </section>

      <footer className="flex flex-col items-start gap-2 border-t border-slate-200 pt-6 text-xs text-slate-500">
        <span>Built for Berkeley Finance Club</span>
        <span>Version v0.1</span>
      </footer>
    </main>
  );
}
