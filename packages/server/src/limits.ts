/**
 * Abuse limits are just limits on calls: a per-IP requests-per-minute limit on every endpoint
 * (the RATE_LIMITER binding), and a daily count of Claude calls per device plus a global daily
 * ceiling, which bounds what generation can cost. Device ids are unlimited, so players on a
 * shared network are never locked out. IPs are only seen as truncated salted hashes.
 */

/** Claude calls one device may make per day (each generation attempt is one call) */
export const CLAUDE_CALLS_PER_DEVICE = 30;

/**
 * Write requests (publish, events, consent, delete) per IP per minute. Counted exactly in D1:
 * the RATE_LIMITER binding in front is approximate (it let ~197 of a 200-request burst through),
 * which is fine as a cheap first filter but not as the limit itself.
 */
export const WRITES_PER_IP_PER_MINUTE = 60;

/** Most mods one player can keep stored */
export const MAX_MODS_PER_DEVICE = 200;
/** Largest request body accepted (a 256 KB source, the app's own limit, plus manifest and JSON escaping) */
export const MAX_BODY_BYTES = 640 * 1024;

export class LimitError extends Error {}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add one to a counter for the current window (UTC day by default) and throw if it's now over `limit` */
export async function bump(db: D1Database, key: string, limit: number, what: string, window: "day" | "minute" = "day"): Promise<void> {
  const period = window === "day" ? today() : new Date().toISOString().slice(0, 16); // "2026-10-31T23:45"
  const row = await db.prepare(
    `INSERT INTO usage_counters (key, day, count) VALUES (?, ?, 1)
     ON CONFLICT (key, day) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(key, period).first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    throw new LimitError(window === "day" ? `daily limit reached: ${what}` : `too many requests: ${what}; wait a minute`);
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Salted, truncated hash of the client IP: enough to rate-limit, not enough to identify */
export async function ipKey(request: Request, salt: string): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 16);
}
