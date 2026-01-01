"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { signIn, signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";

export default function SiteHeader() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated";

  return (
    <header className="sticky top-0 z-40 border-b border-slate-900 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold text-slate-50">
          BFCGPT <span className="text-amber-400">•</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-slate-300">
          <Link
            href="/practice"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-200"
          >
            <motion.span whileHover={{ y: -1 }} className="inline-flex hover:text-slate-50">
              Practice
            </motion.span>
          </Link>
          <Link
            href="/#how-it-works"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-200"
          >
            <motion.span whileHover={{ y: -1 }} className="inline-flex hover:text-slate-50">
              How it Works
            </motion.span>
          </Link>
        </nav>
        <div className="ml-auto">
          {signedIn ? (
            <details className="relative">
              <summary className="list-none">
                <Button variant="secondary" type="button" className="border-slate-800 bg-slate-900 text-slate-100">
                  Account
                </Button>
              </summary>
              <div className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Signed in as
                </div>
                <div className="mt-1 break-words font-medium text-slate-900">
                  {session?.user?.email ?? "Unknown"}
                </div>
                <Button
                  className="mt-3 w-full"
                  variant="secondary"
                  onClick={() => signOut()}
                  type="button"
                >
                  Sign out
                </Button>
              </div>
            </details>
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
