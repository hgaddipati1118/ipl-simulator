/**
 * Mods backend (Cloudflare Worker). See docs/MODS-DESIGN.md.
 *
 *   GET    /health
 *   POST   /consent           { store, sweep }               set what we may keep and analyse
 *   POST   /mods/generate     { prompt, parent? | parentModId?, previous?, installed? }  → a mod or "unsupported"
 *                              (parent = the installed mod being edited, { manifest, source })
 *   POST   /mods              { manifest, source, parentModId?, visibility? }  publish a checked mod
 *   GET    /mods              the caller's own mods
 *   GET    /mods/:id          manifest + source (own or shared)
 *   POST   /events            { kind, modId?, data? }         opt-in usage, for the daily sweep
 *   DELETE /me                delete everything we hold for this device
 *
 * Callers identify with an anonymous `x-device-id` header: a random UUID the app creates once and
 * keeps private. It works as a bearer secret, so only its SHA-256 is stored.
 *
 * Abuse limits (src/limits.ts) are limits on calls: requests per minute per IP (approximate at the
 * edge for every request, exact in D1 for writes), and Claude calls per device per day under a
 * global daily ceiling. Plus size limits on bodies, mods and how many
 * mods one device keeps. Generation is off entirely until ANTHROPIC_API_KEY is set.
 */

import Anthropic from "@anthropic-ai/sdk";
import { checkSource, modHash, parseManifest, type ModManifest } from "./checks";
import { generateMod, type GenerateInput, type PreviousAttempt } from "./generate";
import { bump, CLAUDE_CALLS_PER_DEVICE, ipKey, LimitError, MAX_BODY_BYTES, MAX_MODS_PER_DEVICE, sha256Hex, WRITES_PER_IP_PER_MINUTE } from "./limits";
import { scrubPrompt } from "./scrub";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  /** Per-IP request rate limit (wrangler.toml [[ratelimits]]); absent in unit tests */
  RATE_LIMITER?: RateLimit;
  ANTHROPIC_API_KEY?: string;
  MODEL: string;
  /** Claude calls allowed per day across all players: the hard ceiling on spend */
  GLOBAL_GENERATIONS_PER_DAY: string;
  ALLOWED_ORIGINS: string;
  /** Salt for hashing client IPs */
  IP_SALT?: string;
}

/** Server-side retries when the static checks fail; the app's headless test can ask for more */
const MAX_SERVER_ATTEMPTS = 3;
const MAX_INSTALLED_LISTED = 20;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Caller {
  userId: string;
  ip: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const response = await route(request, env);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof LimitError ? 429 : 500;
      if (status === 500) console.error(err);
      const message = err instanceof HttpError || err instanceof LimitError ? err.message : "internal error";
      return json({ error: message }, status, cors);
    }
  },

  /** Daily: drop old abuse counters */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.DB.prepare("DELETE FROM usage_counters WHERE day < date('now', '-2 days')").run();
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "GET" && path === "/health") return json({ ok: true, generation: Boolean(env.ANTHROPIC_API_KEY) });

  const ip = await ipKey(request, env.IP_SALT ?? "ipl-sim");
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) throw new HttpError(429, "too many requests; slow down");
  }
  // Exact per-IP limit on anything that writes (GETs are cheap reads, covered by RATE_LIMITER)
  if (method !== "GET") await bump(env.DB, `ip:${ip}:writes`, WRITES_PER_IP_PER_MINUTE, "from this network", "minute");
  const caller: Caller = { userId: await ensureUser(request, env), ip };

  if (method === "POST" && path === "/consent") {
    const body = await readJson<{ store?: boolean; sweep?: boolean }>(request);
    await env.DB.prepare("UPDATE users SET consent_store = ?, consent_sweep = ? WHERE id = ?")
      .bind(body.store ? 1 : 0, body.store && body.sweep ? 1 : 0, caller.userId).run();
    return json({ ok: true });
  }
  if (method === "POST" && path === "/mods/generate") return generate(request, env, caller);
  if (method === "POST" && path === "/mods") return publish(request, env, caller);
  if (method === "GET" && path === "/mods") {
    const { results } = await env.DB.prepare(
      "SELECT id, name, manifest, hash, visibility, parent_mod_id, created_at FROM mods WHERE author_id = ? ORDER BY created_at DESC",
    ).bind(caller.userId).all();
    return json({ mods: results.map(r => ({ ...r, manifest: JSON.parse(r.manifest as string) })) });
  }
  const modMatch = path.match(/^\/mods\/([0-9a-f-]{36})$/);
  if (method === "GET" && modMatch) return json(await loadMod(env, caller.userId, modMatch[1]));
  if (method === "POST" && path === "/events") return recordEvent(request, env, caller);
  if (method === "DELETE" && path === "/me") return deleteUser(env, caller.userId);

  throw new HttpError(404, "not found");
}

// ── Generate ─────────────────────────────────────────────────────────────

async function generate(request: Request, env: Env, caller: Caller): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "mod generation isn't switched on yet");

  const body = await readJson<{
    prompt?: string;
    parentModId?: string;
    parent?: unknown;
    previous?: PreviousAttempt;
    installed?: GenerateInput["installed"];
  }>(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new HttpError(400, "prompt is required");
  if (prompt.length > 2000) throw new HttpError(400, "prompt is too long (2000 characters max)");
  const previous = sanitizePrevious(body.previous);
  const installed = sanitizeInstalled(body.installed);


  // The mod being edited: sent by the app (it may only be installed locally) or loaded from the registry
  let parent: GenerateInput["parent"];
  let parentManifest: ModManifest | undefined;
  if (body.parent && typeof body.parent === "object") {
    const p = body.parent as Record<string, unknown>;
    parentManifest = parseManifest(p.manifest).manifest;
    if (!parentManifest || typeof p.source !== "string") throw new HttpError(400, "parent must be a valid { manifest, source }");
    parent = { manifest: JSON.stringify(parentManifest, null, 2), source: p.source.slice(0, 256_000) };
  } else if (body.parentModId) {
    const mod = await loadMod(env, caller.userId, String(body.parentModId));
    parentManifest = mod.manifest;
    parent = { manifest: JSON.stringify(mod.manifest, null, 2), source: mod.source };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const globalLimit = parseInt(env.GLOBAL_GENERATIONS_PER_DAY, 10) || 300;
  let feedback = previous;
  let tokens = { input: 0, output: 0 };
  let model = env.MODEL;

  for (let attempt = 1; attempt <= MAX_SERVER_ATTEMPTS; attempt++) {
    // Every Claude call counts, retries included (a client could otherwise send a made-up
    // `previous` each time to generate for free); the global ceiling bounds the day's spend
    await bump(env.DB, `device:${caller.userId}:claude_calls`, CLAUDE_CALLS_PER_DEVICE, "mod generations for today");
    await bump(env.DB, "global:claude_calls", globalLimit, "mod generation is busy today; try again tomorrow");
    const result = await generateMod(client, env.MODEL, { prompt, parent, previous: feedback, installed });
    tokens = { input: tokens.input + result.usage.inputTokens, output: tokens.output + result.usage.outputTokens };
    model = result.usage.model;

    if (result.kind === "error") {
      if (result.reason === "refusal") {
        await recordPrompt(env, caller.userId, prompt, "none", attempt, model, tokens);
        return json({ kind: "refused", summary: "This request can't be turned into a mod." });
      }
      feedback = { manifest: feedback?.manifest ?? "", source: feedback?.source ?? "", errors: [result.detail] };
      continue;
    }
    if (result.kind === "unsupported") {
      await recordPrompt(env, caller.userId, prompt, "none", attempt, model, tokens);
      return json({ kind: "unsupported", summary: result.summary });
    }

    let parsed: { manifest?: ModManifest; errors: string[] };
    try {
      parsed = parseManifest(JSON.parse(result.manifest));
    } catch {
      parsed = { errors: ["manifest_json is not valid JSON"] };
    }
    const errors = parsed.manifest ? checkSource(result.source, parsed.manifest) : parsed.errors;
    if (parsed.manifest && parentManifest) errors.push(...checkEdit(parentManifest, parsed.manifest));

    if (parsed.manifest && errors.length === 0) {
      await recordPrompt(env, caller.userId, prompt, "mod", attempt, model, tokens);
      // `manifest` + `source` is exactly the app's install bundle
      return json({ kind: "mod", summary: result.summary, manifest: parsed.manifest, source: result.source, attempts: attempt });
    }
    feedback = { manifest: result.manifest, source: result.source, errors };
  }

  await recordPrompt(env, caller.userId, prompt, "none", MAX_SERVER_ATTEMPTS, model, tokens);
  return json({ kind: "failed", summary: "Couldn't produce a mod that passes the checks.", errors: feedback?.errors ?? [] }, 422);
}

/** An edit replaces the installed mod, so it must keep the id and move the version forward */
export function checkEdit(parent: ModManifest, edited: ModManifest): string[] {
  const errors: string[] = [];
  if (edited.id !== parent.id) errors.push(`an edit must keep manifest.id "${parent.id}" (got "${edited.id}")`);
  const v = (s: string) => s.split(/[-+]/)[0].split(".").map(Number);
  const [a, b] = [v(edited.version), v(parent.version)];
  const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (newer <= 0) errors.push(`an edit must raise manifest.version above ${parent.version} (got ${edited.version})`);
  return errors;
}

/** Client-supplied retry feedback goes into the prompt, so bound its size and shape */
function sanitizePrevious(previous: unknown): PreviousAttempt | undefined {
  if (!previous || typeof previous !== "object") return undefined;
  const p = previous as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const errors = Array.isArray(p.errors) ? p.errors.slice(0, 20).map(e => str(e, 300)).filter(Boolean) : [];
  return { manifest: str(p.manifest, 4000), source: str(p.source, 256_000), errors };
}

function sanitizeInstalled(installed: unknown): GenerateInput["installed"] {
  if (!Array.isArray(installed)) return undefined;
  return installed.slice(0, MAX_INSTALLED_LISTED).flatMap(m => {
    if (!m || typeof m !== "object") return [];
    const { name, description, hooks } = m as Record<string, unknown>;
    if (typeof name !== "string") return [];
    return [{
      name: name.slice(0, 80),
      description: typeof description === "string" ? description.slice(0, 300) : "",
      hooks: Array.isArray(hooks) ? hooks.filter((h): h is string => typeof h === "string").slice(0, 12).map(h => h.slice(0, 40)) : [],
    }];
  });
}

async function recordPrompt(
  env: Env, userId: string, prompt: string, kind: "mod" | "branch" | "none",
  attempts: number, model: string, tokens: { input: number; output: number },
): Promise<void> {
  // The prompt text is only kept with consent; without it nothing about the request is stored
  const user = await env.DB.prepare("SELECT consent_store FROM users WHERE id = ?").bind(userId).first<{ consent_store: number }>();
  if (!user?.consent_store) return;
  await env.DB.prepare(
    `INSERT INTO prompts (id, user_id, text, result_kind, result_id, attempts, model, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, scrubPrompt(prompt), kind, attempts, model, tokens.input, tokens.output).run();
}

// ── Registry ─────────────────────────────────────────────────────────────

async function publish(request: Request, env: Env, caller: Caller): Promise<Response> {
  const body = await readJson<{ manifest?: unknown; source?: string; parentModId?: string; visibility?: string }>(request);
  if (!body.manifest || typeof body.source !== "string") throw new HttpError(400, "manifest and source are required");
  // The SDK's validator also normalises the manifest, so it can't carry arbitrary extra data
  const { manifest, errors: manifestErrors } = parseManifest(body.manifest);
  const errors = manifest ? checkSource(body.source, manifest) : manifestErrors;
  if (!manifest || errors.length > 0) return json({ error: "mod failed checks", errors }, 422);

  const user = await env.DB.prepare("SELECT consent_store FROM users WHERE id = ?").bind(caller.userId).first<{ consent_store: number }>();
  if (!user?.consent_store) throw new HttpError(403, "storing mods needs consent (POST /consent { store: true })");

  const hash = await modHash(manifest, body.source);
  // Republishing the same mod returns the caller's existing copy (dedupe is per author: another
  // player's identical mod may be private)
  const existing = await env.DB.prepare("SELECT id FROM mods WHERE author_id = ? AND hash = ?").bind(caller.userId, hash).first<{ id: string }>();
  if (existing) return json({ id: existing.id, hash, existing: true });

  const count = await env.DB.prepare("SELECT count(*) AS n FROM mods WHERE author_id = ?").bind(caller.userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MODS_PER_DEVICE) throw new HttpError(409, `you can keep at most ${MAX_MODS_PER_DEVICE} mods; delete some first`);

  let parentId: string | null = null;
  if (body.parentModId) parentId = (await loadMod(env, caller.userId, String(body.parentModId))).id;

  const id = crypto.randomUUID();
  const bundleKey = `mods/${caller.userId}/${hash}.js`;
  await env.BLOBS.put(bundleKey, body.source, { httpMetadata: { contentType: "text/javascript" } });
  await env.DB.prepare(
    `INSERT INTO mods (id, author_id, name, manifest, sdk_version, bundle_key, hash, parent_mod_id, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, caller.userId, manifest.name, JSON.stringify(manifest), manifest.sdk, bundleKey, hash,
    parentId, body.visibility === "shared" ? "shared" : "private").run();
  return json({ id, hash }, 201);
}

async function loadMod(env: Env, userId: string, id: string): Promise<{ id: string; hash: string; manifest: ModManifest; source: string }> {
  const row = await env.DB.prepare("SELECT id, author_id, manifest, bundle_key, hash, visibility FROM mods WHERE id = ?")
    .bind(id).first<{ id: string; author_id: string; manifest: string; bundle_key: string; hash: string; visibility: string }>();
  if (!row || (row.author_id !== userId && row.visibility !== "shared")) throw new HttpError(404, "mod not found");
  const blob = await env.BLOBS.get(row.bundle_key);
  if (!blob) throw new HttpError(500, "mod bundle missing");
  return { id: row.id, hash: row.hash, manifest: JSON.parse(row.manifest), source: await blob.text() };
}

// ── Events ───────────────────────────────────────────────────────────────

async function recordEvent(request: Request, env: Env, caller: Caller): Promise<Response> {
  const body = await readJson<{ kind?: string; modId?: string; data?: unknown }>(request);
  if (typeof body.kind !== "string" || !/^[a-z_.]{1,40}$/.test(body.kind)) throw new HttpError(400, "kind is required");
  const modId = typeof body.modId === "string" && /^[0-9a-f-]{36}$/.test(body.modId) ? body.modId : null;
  // Usage events only feed the cross-user sweep, so they're dropped without that consent
  const user = await env.DB.prepare("SELECT consent_sweep FROM users WHERE id = ?").bind(caller.userId).first<{ consent_sweep: number }>();
  if (!user?.consent_sweep) return json({ ok: true, stored: false });
  const data = body.data === undefined ? null : JSON.stringify(body.data).slice(0, 2000);
  await env.DB.prepare("INSERT INTO events (user_id, kind, mod_id, data) VALUES (?, ?, ?, ?)")
    .bind(caller.userId, body.kind, modId, data).run();
  return json({ ok: true, stored: true });
}

// ── Users ────────────────────────────────────────────────────────────────

async function ensureUser(request: Request, env: Env): Promise<string> {
  const deviceId = request.headers.get("x-device-id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new HttpError(401, "x-device-id header (a UUID) is required");
  }
  const userId = await sha256Hex(`device:${deviceId.toLowerCase()}`);
  await env.DB.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").bind(userId).run();
  return userId;
}

async function deleteUser(env: Env, userId: string): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT bundle_key FROM mods WHERE author_id = ?").bind(userId).all<{ bundle_key: string }>();
  for (let i = 0; i < results.length; i += 1000) await env.BLOBS.delete(results.slice(i, i + 1000).map(r => r.bundle_key));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mod_installs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM code_changes WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM prompts WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE mods SET parent_mod_id = NULL WHERE parent_mod_id IN (SELECT id FROM mods WHERE author_id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM mods WHERE author_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM usage_counters WHERE key LIKE ?").bind(`device:${userId}:%`),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  return json({ ok: true, deleted: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map(s => s.trim());
  return allowed.includes(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, x-device-id",
        vary: "origin",
      }
    : {};
}

/** Parse a JSON body, refusing anything over MAX_BODY_BYTES before reading it all */
async function readJson<T>(request: Request): Promise<T> {
  const declared = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as T;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
