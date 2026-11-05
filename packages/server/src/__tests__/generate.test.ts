import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { generateMod } from "../generate";

/** A stand-in client whose beta.messages.create returns a canned response and records the request */
function fakeClient(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            model: "claude-opus-5-5",
            usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 1000 },
            stop_details: null,
            ...response,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const modJson = JSON.stringify({
  kind: "mod",
  summary: "Spinners take about 15% more wickets at Chepauk.",
  manifest_json: '{"id":"spin-chepauk","name":"Spin Chepauk","version":"1.0.0","sdk":"1","hooks":["engine.ballProbabilities"],"description":"More spin wickets in Chennai."}',
  module: 'import { defineMod } from "@ipl-sim/mods";\nexport default defineMod({ engine: { ballProbabilities(ctx, p) { return p; } } });',
});

describe("generateMod", () => {
  it("returns the mod and usage, and caches the shared context", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: modJson }] });
    const result = await generateMod(client, "claude-opus-5-5", { prompt: "spinners should matter more in Chennai" });

    expect(result.kind).toBe("mod");
    if (result.kind !== "mod") return;
    expect(JSON.parse(result.manifest).id).toBe("spin-chepauk");
    expect(result.usage).toEqual({ model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 });

    const req = calls[0] as { system: { cache_control: unknown }[]; fallbacks: string; output_config: { format: { type: string } } };
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(req.fallbacks).toBe("default");
    expect(req.output_config.format.type).toBe("json_schema");
  });

  it("puts retry feedback and the request in the user turn, not the cached system prompt", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: modJson }] });
    await generateMod(client, "claude-opus-5-5", {
      prompt: "make it stronger",
      previous: { manifest: "{}", module: "export default 1", errors: ["unknown hook \"engine.x\""] },
    });
    const req = calls[0] as { system: { text: string }[]; messages: { content: string }[] };
    expect(req.messages[0].content).toContain('unknown hook "engine.x"');
    expect(req.messages[0].content).toContain("make it stronger");
    expect(req.system[0].text).not.toContain("make it stronger");
  });

  it("passes through 'unsupported'", async () => {
    const text = JSON.stringify({ kind: "unsupported", summary: "Needs a new auction screen.", manifest_json: "", module: "" });
    const { client } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text }] });
    expect(await generateMod(client, "m", { prompt: "rebuild the auction" })).toMatchObject({ kind: "unsupported", summary: "Needs a new auction screen." });
  });

  it("reports refusals, truncation and malformed output as errors", async () => {
    const refused = fakeClient({ stop_reason: "refusal", stop_details: { explanation: "declined" }, content: [] });
    expect(await generateMod(refused.client, "m", { prompt: "x" })).toMatchObject({ kind: "error", reason: "refusal" });

    const truncated = fakeClient({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"kind":' }] });
    expect(await generateMod(truncated.client, "m", { prompt: "x" })).toMatchObject({ kind: "error", reason: "truncated" });

    const malformed = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] });
    expect(await generateMod(malformed.client, "m", { prompt: "x" })).toMatchObject({ kind: "error", reason: "malformed" });
  });
});
