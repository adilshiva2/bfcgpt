export function isAllowedEmail(email?: string | null) {
  const normalized = (email || "").toLowerCase();
  if (!normalized) return false;
  const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(normalized);
}
