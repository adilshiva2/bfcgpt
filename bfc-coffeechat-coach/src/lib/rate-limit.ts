const WINDOW_MS = 5 * 60 * 1000;

type Bucket = {
  timestamps: number[];
};

const userBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();

function prune(bucket: Bucket, now: number) {
  bucket.timestamps = bucket.timestamps.filter((ts) => now - ts <= WINDOW_MS);
}

function checkLimit(buckets: Map<string, Bucket>, key: string, limit: number, now: number) {
  const bucket = buckets.get(key) ?? { timestamps: [] };
  prune(bucket, now);

  if (bucket.timestamps.length >= limit) {
    const earliest = bucket.timestamps[0] ?? now;
    const retryAfterMs = Math.max(0, WINDOW_MS - (now - earliest));
    return { allowed: false, retryAfterMs };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return { allowed: true, retryAfterMs: 0 };
}

export function enforceRateLimit(params: { userKey: string; ipKey: string }) {
  // NOTE: In-memory buckets reset on serverless cold starts. This is baseline protection only.
  const now = Date.now();
  const userResult = checkLimit(userBuckets, params.userKey, 10, now);
  if (!userResult.allowed) {
    return { allowed: false, retryAfterMs: userResult.retryAfterMs };
  }

  const ipResult = checkLimit(ipBuckets, params.ipKey, 30, now);
  if (!ipResult.allowed) {
    return { allowed: false, retryAfterMs: ipResult.retryAfterMs };
  }

  return { allowed: true, retryAfterMs: 0 };
}
