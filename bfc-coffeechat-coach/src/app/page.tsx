import Link from "next/link";

export default function Home() {
  return (
    <main className="p-8 space-y-4">
      <h1 className="text-3xl font-bold">BFC Coffee Chat Coach</h1>

      <div className="flex gap-3">
        <Link className="underline" href="/api/auth/signin">
          Sign in
        </Link>
        <Link className="underline" href="/api/auth/signout">
          Sign out
        </Link>
      </div>

      <Link className="underline" href="/practice">
        Go to Practice
      </Link>
    </main>
  );
}
