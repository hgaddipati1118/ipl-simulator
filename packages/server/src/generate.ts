/**
 * Turn a player's request into a mod: one Claude call returns a manifest + module written against
 * the Mod SDK, or "unsupported" when no SDK hook can express the request (the app then offers a
 * personal code branch instead). Callers retry with the checker's errors as feedback.
 */

import Anthropic from "@anthropic-ai/sdk";
import { EXAMPLE_MODS, SDK_TYPES, SDK_VERSION } from "./sdk-context";

export interface PreviousAttempt {
  manifest: string;
  source: string;
  /** What the static checks or the app's headless test reported */
  errors: string[];
}

export interface GenerateInput {
  prompt: string;
  /** The mod being edited, when this is a follow-up ("make it 2 overs instead") */
  parent?: { manifest: string; source: string };
  previous?: PreviousAttempt;
  /** Names and descriptions of the player's other installed mods, to avoid clashes */
  installed?: { name: string; description: string; hooks: string[] }[];
}

export type GenerateResult =
  | { kind: "mod"; summary: string; manifest: string; source: string; usage: Usage }
  | { kind: "unsupported"; summary: string; usage: Usage }
  | { kind: "error"; reason: "refusal" | "truncated" | "malformed"; detail: string; usage: Usage };

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const SYSTEM = `You write mods for a T20 cricket management game (IPL-style leagues, auctions, ball-by-ball match simulation).

A mod is a small ES module plus a JSON manifest, written against Mod SDK v${SDK_VERSION}. Mods change the game only through the SDK's hooks; they never touch the game's internals. The game runs every hook through a validator, so a mod must:
- be a single module whose only statement at the top level is \`export default defineMod({...})\` (helper functions defined above it are fine); \`defineMod\` is provided by the game, so there is nothing to import
- keep engine and data hooks pure and deterministic: use ctx.rng for randomness, never Math.random or the current time
- not use the network, browser storage, the page, or dynamic code
- return values of the documented shape (probabilities stay finite and non-negative; the engine renormalises them)

Keep effects proportionate to what the player asked for: a request like "spinners should matter more in Chennai" means a noticeable but believable shift, not a doubled wicket rate. Prefer the smallest set of hooks that does the job, and give the mod a clear name and a one-sentence description a player would understand.

If the request can't be done with the SDK's hooks (it needs a new screen layout the slots don't offer, a change to how auctions work internally, and so on), answer with kind "unsupported" and explain in one or two sentences what would be needed. Don't produce a mod that only half does what was asked.

In "summary", tell the player in plain words what the mod changes (for "unsupported", why not). Return the manifest as a JSON string in "manifest_json" and the module source in "source"; for "unsupported" leave both empty.

## SDK types

\`\`\`ts
${SDK_TYPES}
\`\`\`

## Example mods

${EXAMPLE_MODS.map(e => "```js\n" + e + "\n```").join("\n\n")}`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary", "manifest_json", "source"],
  properties: {
    kind: { type: "string", enum: ["mod", "unsupported"] },
    summary: { type: "string" },
    manifest_json: { type: "string" },
    source: { type: "string" },
  },
} as const;

function userMessage(input: GenerateInput): string {
  const parts: string[] = [];
  if (input.installed?.length) {
    parts.push("The player already has these mods installed (don't duplicate or fight them):\n" +
      input.installed.map(m => `- ${m.name} [${m.hooks.join(", ")}]: ${m.description}`).join("\n"));
  }
  if (input.parent) {
    parts.push(`They are editing this existing mod. Return the full updated mod: keep the same manifest id, raise the version (a patch or minor bump), and change only what they asked for.\n\nmanifest.json:\n${input.parent.manifest}\n\nmod.js:\n${input.parent.source}`);
  }
  if (input.previous) {
    parts.push(`Your previous attempt failed these checks; fix them and return the full corrected mod.\n` +
      input.previous.errors.map(e => `- ${e}`).join("\n") +
      `\n\nPrevious manifest.json:\n${input.previous.manifest}\n\nPrevious mod.js:\n${input.previous.source}`);
  }
  parts.push(`The player's request:\n${input.prompt}`);
  return parts.join("\n\n---\n\n");
}

export async function generateMod(client: Anthropic, model: string, input: GenerateInput): Promise<GenerateResult> {
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    // The instructions, SDK types and examples are identical on every call: cache them
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: userMessage(input) }],
  });

  const usage: Usage = {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    return { kind: "error", reason: "refusal", detail: response.stop_details?.explanation ?? "declined", usage };
  }
  if (response.stop_reason === "max_tokens") {
    return { kind: "error", reason: "truncated", detail: "the response hit the output limit", usage };
  }

  const text = response.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
  let parsed: { kind: "mod" | "unsupported"; summary: string; manifest_json: string; source: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "error", reason: "malformed", detail: "the response wasn't valid JSON", usage };
  }
  if (parsed.kind === "unsupported") return { kind: "unsupported", summary: parsed.summary, usage };
  return { kind: "mod", summary: parsed.summary, manifest: parsed.manifest_json, source: parsed.source, usage };
}
