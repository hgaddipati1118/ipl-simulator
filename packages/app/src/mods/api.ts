/**
 * Client for the mods backend (packages/server). Set VITE_MODS_API to its URL; without it the
 * prompt-to-mod and sharing features are hidden and everything else works offline as before.
 */

import type { ModBundle, ModManifest } from "@ipl-sim/mods";
import { verifyMod, type VerifyResult } from "./verify";

const BASE = (import.meta.env.VITE_MODS_API as string | undefined)?.replace(/\/+$/, "");
const DEVICE_KEY = "ipl-sim-device-id";
/** Generate → verify in the browser → regenerate with the errors, at most this many times */
const MAX_ROUNDS = 3;

export const modsApiEnabled = Boolean(BASE);

/** A random id that identifies this browser to the backend. It's a secret: never show or share it. */
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export class ModsApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!BASE) throw new ModsApiError(0, "mod creation isn't set up in this build");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "x-device-id": deviceId(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ModsApiError(0, "couldn't reach the mods server; check your connection");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && res.status !== 422) throw new ModsApiError(res.status, data.error ?? `request failed (${res.status})`);
  return data;
}

export async function serverStatus(): Promise<{ ok: boolean; generation: boolean }> {
  return call("GET", "/health");
}

export async function setConsent(store: boolean, sweep: boolean): Promise<void> {
  await call("POST", "/consent", { store, sweep });
}

type GenerateResponse =
  | { kind: "mod"; summary: string; manifest: ModManifest; source: string }
  | { kind: "unsupported" | "refused"; summary: string }
  | { kind: "failed"; summary: string; errors: string[] };

export type CreateResult =
  | { kind: "ready"; summary: string; verified: VerifyResult & { bundle: ModBundle; hash: string } }
  | { kind: "unsupported" | "refused" | "failed"; summary: string; errors?: string[] };

/**
 * Turn a prompt into a mod that has passed both the server's static checks and the browser's
 * test matches. Failures from the browser go back to the server as feedback for another try.
 */
export async function createModFromPrompt(
  prompt: string,
  options: {
    /** The installed mod being edited: the result keeps its id and replaces it */
    parent?: ModBundle;
    installed?: { name: string; description: string; hooks: string[] }[];
    onProgress?: (msg: string) => void;
  } = {},
): Promise<CreateResult> {
  let previous: { manifest: string; source: string; errors: string[] } | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    options.onProgress?.(round === 1 ? "Writing your mod…" : `Fixing problems the test matches found (try ${round} of ${MAX_ROUNDS})…`);
    const res = await call<GenerateResponse>("POST", "/mods/generate", {
      prompt, parent: options.parent, installed: options.installed, previous,
    });
    if (res.kind !== "mod") return res;

    options.onProgress?.("Testing it in a few simulated matches…");
    const verified = await verifyMod({ manifest: res.manifest, source: res.source });
    if (options.parent && res.manifest.id !== options.parent.manifest.id) {
      verified.ok = false;
      verified.errors.push(`an edit must keep manifest.id "${options.parent.manifest.id}"`);
    }
    if (verified.ok && verified.bundle && verified.hash) {
      return { kind: "ready", summary: res.summary, verified: { ...verified, bundle: verified.bundle, hash: verified.hash } };
    }
    previous = { manifest: JSON.stringify(res.manifest), source: res.source, errors: verified.errors };
  }
  return { kind: "failed", summary: "Couldn't make a mod that passes the test matches.", errors: previous?.errors };
}

/** Upload a mod so it can be shared by link (needs consent to store mods) */
export async function shareMod(bundle: ModBundle): Promise<{ id: string; url: string }> {
  const res = await call<{ id: string; error?: string; errors?: string[] }>("POST", "/mods", { ...bundle, visibility: "shared" });
  if (!res.id) throw new ModsApiError(422, res.errors?.join("; ") ?? res.error ?? "the server rejected this mod");
  // The Mods page installs from ?install=<id> (BrowserRouter, so a plain path)
  return { id: res.id, url: `${window.location.origin}/mods?install=${res.id}` };
}

/** Fetch a shared mod and check it locally before offering to install it */
export async function fetchSharedMod(id: string): Promise<VerifyResult> {
  const res = await call<{ manifest: ModManifest; source: string }>("GET", `/mods/${encodeURIComponent(id)}`);
  return verifyMod({ manifest: res.manifest, source: res.source });
}
