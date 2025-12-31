"use client";

import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";

export default function SiteHeader() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated";

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-4">
        <Link href="/" className="text-lg font-semibold">
          BFC Coffee Chat Coach
        </Link>
        <Link href="/practice" className="text-sm text-slate-600 hover:text-slate-900">
          Practice
        </Link>
        <div className="ml-auto">
          {signedIn ? (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border px-3 py-2 text-sm">
                Account
              </summary>
              <div className="absolute right-0 mt-2 w-56 rounded-md border bg-white p-3 text-sm shadow-sm">
                <div className="text-slate-600">Signed in as</div>
                <div className="mt-1 font-medium text-slate-900">
                  {session?.user?.email ?? "Unknown"}
                </div>
                <button
                  className="mt-3 w-full rounded-md border px-3 py-2 text-sm"
                  onClick={() => signOut()}
                  type="button"
                >
                  Sign out
                </button>
              </div>
            </details>
          ) : (
            <button
              className="rounded-md border px-3 py-2 text-sm"
              onClick={() => signIn()}
              type="button"
              disabled={status === "loading"}
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
