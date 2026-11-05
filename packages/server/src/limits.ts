/**
 * Abuse limits are just limits on calls: a per-IP requests-per-minute limit on every endpoint
 * (the RATE_LIMITER binding), and a daily count of Claude calls per device plus a global daily
 * ceiling, which bounds what generation can cost. Device ids are unlimited, so players on a
 * shared network are never locked out. IPs are only seen as truncated salted hashes.
 */

/** Claude calls one device may make per day (each generation attempt is one call) */
export const CLAUDE_CALLS_PER_DEVICE = 30;

/** Most mods one player can keep stored */
export const MAX_MODS_PER_DEVICE = 200;
/** Largest request body accepted (a 64KB module plus its manifest and JSON overhead) */
export const MAX_BODY_BYTES = 160 * 1024;

export class LimitError extends Error {}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add one to a daily counter and throw if it's now over `limit` */
export async function bump(db: D1Database, key: string, limit: number, what: string): Promise<void> {
  const row = await db.prepare(
    `INSERT INTO usage_counters (key, day, count) VALUES (?, ?, 1)
     ON CONFLICT (key, day) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(key, today()).first<{ count: number }>();
  if ((row?.count ?? 0) > limit) throw new LimitError(`daily limit reached: ${what}`);
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
