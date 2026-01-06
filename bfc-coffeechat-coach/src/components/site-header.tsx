"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { signIn, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import AccountMenu from "@/components/account-menu";

export default function SiteHeader() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated";

  return (
    <header className="sticky top-0 z-40 border-b border-slate-900 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold text-slate-50">
          ChatBFC <span className="text-amber-400">•</span>
          <Badge tone="neutral" className="text-[10px] uppercase tracking-wide text-slate-900">
            Beta
          </Badge>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-slate-300">
          <Link
            href="/practice"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-200"
          >
            <motion.span whileHover={{ y: -1 }} className="inline-flex hover:text-slate-50">
              Coffee Chats
            </motion.span>
          </Link>
          <Link
            href="/mock-interview"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-200"
          >
            <motion.span whileHover={{ y: -1 }} className="inline-flex hover:text-slate-50">
              Mock Interview
            </motion.span>
          </Link>
        </nav>
        <div className="ml-auto">
          {signedIn ? (
            <AccountMenu key={session?.user?.email ?? "unknown"} email={session?.user?.email ?? ""} />
          ) : (
            <Button
              onClick={() => signIn()}
              type="button"
              disabled={status === "loading"}
              variant="secondary"
              className="border-slate-800 bg-slate-900 text-slate-100"
            >
              Sign in
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
