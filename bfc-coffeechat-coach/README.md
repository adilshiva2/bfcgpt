This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [https://bfcgpt.com](https://bfcgpt.com) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment

Copy `bfc-coffeechat-coach/.env.example` to `bfc-coffeechat-coach/.env.local` and fill in your values. Use `ALLOWED_EMAILS` as a comma-separated allowlist. For Google OAuth, set `NEXTAUTH_URL` to your deployed URL (e.g. `https://YOURPROJECT.vercel.app`) and register the redirect URI:

```
https://YOURPROJECT.vercel.app/api/auth/callback/google
```

To enable realtime debug logging in the browser, set `NEXT_PUBLIC_DEBUG_REALTIME=true`.

To debug coaching responses in the browser, set `NEXT_PUBLIC_DEBUG_COACH=true`.

To debug ElevenLabs TTS in the browser, set `NEXT_PUBLIC_DEBUG_TTS=true`.

## ElevenLabs TTS

Set the following environment variables to enable interviewer voice playback:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_MODEL_ID` (optional)

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
