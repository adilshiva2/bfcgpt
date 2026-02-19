/**
 * Emails hardcoded here are always allowed, in addition to any emails
 * listed in the ALLOWED_EMAILS environment variable.
 */
const HARDCODED_ALLOWED_EMAILS: string[] = [
  "tashigotlieb@gmail.com",
];

export function isAllowedEmail(email?: string | null) {
  const normalized = (email || "").toLowerCase();
  if (!normalized) return false;
  const envAllowed = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set([
    ...envAllowed,
    ...HARDCODED_ALLOWED_EMAILS.map((e) => e.toLowerCase()),
  ]);
  return allowed.has(normalized);
}
