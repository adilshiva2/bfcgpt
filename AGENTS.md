## Working Agreements

- Make minimal changes that fix the bug.
- After code changes, run `npm run lint`, `npm run build` (and `npx tsc --noEmit` if available).
- If you change auth/env, update `.env.example` and document it in `README.md`.
- Never introduce random/Date-based SSR mismatches.
- Prefer fixing the root cause over workarounds.
