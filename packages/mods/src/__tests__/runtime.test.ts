import { describe, it, expect } from "vitest";
import { ValidationError, validateMatchFormat, validatePlayers, validateProbabilities, validateRules, validateTeams, validateTheme } from "../validate.js";
import { checkDefinition, compileMod, hashBundle, parseBundle } from "../bundle.js";
import { compareFingerprints } from "../fingerprint.js";
import { ModRuntime } from "../runtime.js";
import type { BallProbabilities, ModRuleSet } from "../sdk.js";
import { addBundle, addInline, CTX, loadExample, PROBS, runtimeWithClock } from "./helpers.js";

const sum = (p: BallProbabilities) => Object.values(p).reduce((a, b) => a + b, 0);
const call = (r: ModRuntime, probs: BallProbabilities = PROBS) => r.engineHooks().ballProbabilities!(CTX, probs);

describe("validateProbabilities", () => {
  it("renormalises to 1 and drops extra keys", () => {
    const out = validateProbabilities({ ...PROBS, wicket: 0.5, junk: 7 });
    expect(sum(out)).toBeCloseTo(1, 12);
    expect(Object.keys(out)).not.toContain("junk");
  });
  it.each([
    ["NaN", { ...PROBS, wicket: NaN }],
    ["Infinity", { ...PROBS, dot: Infinity }],
    ["negative", { ...PROBS, "4": -0.1 }],
    ["missing key", (({ wicket: _w, ...rest }) => rest)(PROBS)],
    ["string number", { ...PROBS, dot: "0.3" }],
    ["all zero", Object.fromEntries(Object.keys(PROBS).map(k => [k, 0]))],
    ["not an object", null],
    ["array", [1, 2, 3]],
  ])("rejects %s", (_name, value) => {
    expect(() => validateProbabilities(value)).toThrow(ValidationError);
  });
});

describe("engine hook composition and fault isolation", () => {
  it("composes mods in install order", () => {
    const { runtime } = runtimeWithClock();
    const seen: number[] = [];
    addInline(runtime, "first", ["engine.ballProbabilities"], { engine: { ballProbabilities: (_c, p) => { seen.push(sum(p)); return { ...p, wicket: p.wicket * 2 }; } } });
    addInline(runtime, "second", ["engine.ballProbabilities"], { engine: { ballProbabilities: (_c, p) => ({ ...p, wicket: p.wicket + 1 }) } });
    const out = call(runtime);
    // second saw the doubled (renormalised) wicket weight, then added 1
    const afterFirst = validateProbabilities({ ...PROBS, wicket: PROBS.wicket * 2 }).wicket;
    const expected = validateProbabilities({ ...validateProbabilities({ ...PROBS, wicket: PROBS.wicket * 2 }), wicket: afterFirst + 1 });
    expect(out.wicket).toBeCloseTo(expected.wicket, 10);
    expect(sum(out)).toBeCloseTo(1, 12);
  });

  it("has no hooks at all without engine mods, so the engine takes its fast path", () => {
    const { runtime } = runtimeWithClock();
    expect(runtime.engineHooks()).toEqual({});
    addInline(runtime, "theme", ["ui.theme"], { ui: { theme: { variables: { "--th-body": "#000" } } } });
    expect(runtime.engineHooks()).toEqual({});
    expect(runtime.hasSimulationMods()).toBe(false);
  });

  it("skips a throwing mod, keeps the others, and disables it on the third strike", () => {
    const faults: string[] = [];
    const { runtime } = runtimeWithClock({ onFault: f => faults.push(`${f.modId}:${f.strikes}:${f.disabled}`) });
    let badCalls = 0;
    addInline(runtime, "bad", ["engine.ballProbabilities"], { engine: { ballProbabilities: () => { badCalls++; throw new Error("boom"); } } });
    addInline(runtime, "good", ["engine.ballProbabilities"], { engine: { ballProbabilities: (_c, p) => ({ ...p, wicket: p.wicket * 2 }) } });
    const hooks = runtime.engineHooks();

    for (let i = 0; i < 3; i++) {
      const out = hooks.ballProbabilities!(CTX, PROBS);
      expect(out.wicket).toBeGreaterThan(PROBS.wicket * 1.9); // good mod still applied
    }
    expect(badCalls).toBe(3);
    expect(faults).toEqual(["bad:1:false", "bad:2:false", "bad:3:true"]);
    const status = runtime.list().find(s => s.id === "bad")!;
    expect(status.enabled).toBe(false);
    expect(status.strikes).toBe(3);
    expect(status.disabledReason).toMatch(/boom/);

    hooks.ballProbabilities!(CTX, PROBS);
    expect(badCalls).toBe(3); // no longer called
    expect(runtime.list().find(s => s.id === "good")!.enabled).toBe(true);
  });

  it("skips and disables a mod that returns NaN", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "nan", ["engine.ballProbabilities"], { engine: { ballProbabilities: (_c, p) => ({ ...p, wicket: NaN }) } });
    for (let i = 0; i < 3; i++) {
      const out = call(runtime);
      expect(Object.values(out).every(Number.isFinite)).toBe(true);
      expect(out).toEqual(PROBS);
    }
    const s = runtime.list()[0];
    expect(s.enabled).toBe(false);
    expect(s.lastError).toMatch(/not a finite number/);
  });

  it("treats a call over the time budget as a failure", () => {
    const { runtime, clock } = runtimeWithClock({ budgets: { engineMs: 5 } });
    addInline(runtime, "slow", ["engine.ballProbabilities"], { engine: { ballProbabilities: (_c, p) => { clock.t += 50; return { ...p, wicket: p.wicket * 10 }; } } });
    expect(call(runtime)).toEqual(PROBS);
    expect(runtime.list()[0].strikes).toBe(1);
    expect(runtime.list()[0].lastError).toMatch(/budget/);
  });

  it("re-enabling clears strikes", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "nan", ["engine.ballProbabilities"], { engine: { ballProbabilities: (_c, p) => ({ ...p, dot: -1 }) } });
    for (let i = 0; i < 3; i++) call(runtime);
    expect(runtime.list()[0].enabled).toBe(false);
    runtime.setEnabled("nan", true);
    expect(runtime.list()[0]).toMatchObject({ enabled: true, strikes: 0 });
  });

  it("notifies subscribers when a mod is disabled", () => {
    const { runtime } = runtimeWithClock();
    const seen: boolean[] = [];
    runtime.subscribe(statuses => seen.push(statuses[0]?.enabled ?? false));
    addInline(runtime, "bad", ["engine.ballProbabilities"], { engine: { ballProbabilities: () => { throw new Error("x"); } } });
    for (let i = 0; i < 3; i++) call(runtime);
    expect(seen.at(-1)).toBe(false);
  });

  it("onBall failures are isolated too", () => {
    const { runtime } = runtimeWithClock();
    let ok = 0;
    addInline(runtime, "bad", ["engine.onBall"], { engine: { onBall: () => { throw new Error("nope"); } } });
    addInline(runtime, "ok", ["engine.onBall"], { engine: { onBall: () => { ok++; } } });
    const hooks = runtime.engineHooks();
    hooks.onBall!(CTX, { outcome: "dot", runs: 0, extras: 0, isWicket: false });
    expect(ok).toBe(1);
    expect(runtime.list()[0].strikes).toBe(1);
  });

  it("validates matchFormat", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "fmt", ["engine.matchFormat"], { engine: { matchFormat: f => ({ ...f, overs: 10, powerplayOvers: 3, maxOversPerBowler: 2 }) } });
    expect(runtime.engineHooks().matchFormat!({ overs: 20, powerplayOvers: 6, maxOversPerBowler: 4, superOverOvers: 1 })).toMatchObject({ overs: 10 });
    expect(() => validateMatchFormat({ overs: 40, powerplayOvers: 6, maxOversPerBowler: 4, superOverOvers: 1 })).toThrow(/cannot be bowled/);
    expect(() => validateMatchFormat({ overs: 20.5, powerplayOvers: 6, maxOversPerBowler: 4, superOverOvers: 1 })).toThrow(ValidationError);
  });
});

const RULES: ModRuleSet = {
  name: "Test", league: "ipl", teamIds: ["csk", "mi", "rcb", "kkr"], impactPlayer: true, salaryCap: 120,
  maxBouncersPerOver: 2, superOverTieBreaker: "repeated-super-over", maxOverseasInXI: 4, maxOverseasInSquad: 8,
  maxSquadSize: 25, matchesPerTeam: 14, playoffTeams: 2, playoffFormat: "eliminator", scoringMultiplier: 1,
  injuriesEnabled: true,
};

describe("data and rules hooks", () => {
  it("applies rules in order and validates fields", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "a", ["rules"], { rules: r => ({ ...r, scoringMultiplier: 1.1, impactPlayer: false }) });
    addInline(runtime, "b", ["rules"], { rules: r => ({ ...r, scoringMultiplier: r.scoringMultiplier * 1.5 }) });
    const out = runtime.applyRules(RULES);
    expect(out.scoringMultiplier).toBeCloseTo(1.65, 10);
    expect(out.impactPlayer).toBe(false);
  });

  it.each([
    ["unknown field", { ...RULES, hax: 1 }],
    ["out of range", { ...RULES, scoringMultiplier: 9 }],
    ["wrong type", { ...RULES, impactPlayer: "yes" }],
    ["bad enum", { ...RULES, playoffFormat: "knockout" }],
    ["unknown team", { ...RULES, teamIds: ["csk", "zzz"] }],
    ["too many playoff teams", { ...RULES, playoffTeams: 4 }],
    ["missing field", (({ name: _n, ...rest }) => rest)(RULES)],
  ])("rejects rules with %s", (_n, value) => {
    expect(() => validateRules(value, RULES)).toThrow(ValidationError);
  });

  it("allows new team ids that data.teams added", () => {
    expect(validateRules({ ...RULES, teamIds: ["csk", "new-team"], playoffTeams: 1 }, RULES, { knownTeamIds: ["new-team"] }).teamIds).toContain("new-team");
  });

  it("a bad rules mod is skipped and struck", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "bad", ["rules"], { rules: r => ({ ...r, salaryCap: -5 }) });
    expect(runtime.applyRules(RULES)).toEqual(RULES);
    expect(runtime.list()[0].strikes).toBe(1);
  });

  const player = (id: string, over: object = {}) => ({
    id, name: id, age: 25, country: "India", role: "batsman", isInternational: false,
    ratings: { battingIQ: 60, timing: 60, power: 60, running: 60, wicketTaking: 20, economy: 20, accuracy: 20, clutch: 50 }, ...over,
  });

  it("validates players, clamps ratings and keeps extra fields", () => {
    const out = validatePlayers([player("a", { ratings: { ...player("x").ratings, power: 130, timing: -4 }, form: 77 })]);
    expect(out[0].ratings.power).toBe(99);
    expect(out[0].ratings.timing).toBe(1);
    expect(out[0].form).toBe(77);
    expect(() => validatePlayers([player("a"), player("a")])).toThrow(/duplicate/);
    expect(() => validatePlayers([player("a", { role: "umpire" })])).toThrow(ValidationError);
    expect(() => validatePlayers([player("a", { ratings: { ...player("x").ratings, power: NaN } })])).toThrow(ValidationError);
    expect(() => validatePlayers("nope")).toThrow(ValidationError);
  });

  it("hands data hooks a copy so a throwing mod cannot corrupt the input", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "mutator", ["data.players"], { data: { players: ps => { ps[0].name = "HACKED"; throw new Error("late"); } } });
    const input = validatePlayers([player("a")]);
    expect(runtime.applyPlayers(input)[0].name).toBe("a");
    expect(input[0].name).toBe("a");
  });

  it("validates teams", () => {
    const t = (id: string, over: object = {}) => ({ id, name: id, shortName: id.toUpperCase(), city: "X", primaryColor: "#112233", secondaryColor: "#fff", ...over });
    expect(validateTeams([t("aa"), t("bb")])).toHaveLength(2);
    expect(() => validateTeams([t("aa"), t("aa")])).toThrow(/duplicate/);
    expect(() => validateTeams([t("aa"), t("bb", { primaryColor: "red" })])).toThrow(/colour/);
    expect(() => validateTeams([t("aa")])).toThrow(ValidationError);
  });
});

describe("static UI content", () => {
  it("accepts plain CSS variables and rejects anything that can load or inject", () => {
    expect(validateTheme({ dark: { "--th-body": "#000", "--mod-x": "rgba(1, 2, 3, 0.5)" }, fonts: { body: "Georgia, serif" } })).toBeTruthy();
    for (const bad of [
      { variables: { "--th-body": "url(http://evil/x.png)" } },
      { variables: { "color": "red" } },
      { variables: { "--th-body": "red; background: url(x)" } },
      { variables: { "--th-body": "red}body{display:none" } },
      { fonts: { body: "x; } @import 'evil'" } },
    ]) expect(() => validateTheme(bad)).toThrow(ValidationError);
  });
});

describe("bundles", () => {
  it("loads the example mods", async () => {
    const runtime = new ModRuntime();
    await addBundle(runtime, loadExample("spin-friendly-chennai"));
    await addBundle(runtime, loadExample("midnight-theme"));
    expect(runtime.list().map(s => s.id)).toEqual(["spin-friendly-chennai", "midnight-theme"]);
    expect(runtime.theme().dark?.["--th-body"]).toBe("#070b1a");
    expect(runtime.hasSimulationMods()).toBe(true);
    expect(runtime.fingerprint()).toHaveLength(1);
    expect(runtime.fingerprint()[0]).toMatch(/^spin-friendly-chennai@[0-9a-f]{64}$/);
  });

  it("rejects bad manifests and modules", () => {
    const m = loadExample("spin-friendly-chennai");
    expect(() => parseBundle({ manifest: { ...m.manifest, sdk: "2" }, source: m.source })).toThrow(/SDK version/);
    expect(() => parseBundle({ manifest: { ...m.manifest, hooks: ["engine.nothing"] }, source: m.source })).toThrow(/unknown hook/);
    expect(() => parseBundle({ manifest: m.manifest, source: "" })).toThrow(ValidationError);
    expect(() => compileMod({ ...m, source: "const x = 1;" })).toThrow(/default export/);
    expect(() => compileMod({ ...m, source: 'import x from "y"; export default {};' })).toThrow(/cannot import/);
    expect(() => compileMod({ ...m, source: "export default defineMod({ engine: { ballProbabilities( {" })).toThrow(/failed to load/);
    expect(() => compileMod({ ...m, source: "export default defineMod({ engine: { onBall() {} } });" })).toThrow(/not declared/);
    expect(() => compileMod({ ...m, source: "export default defineMod({});" })).toThrow(/does not implement/);
    expect(() => compileMod({ ...m, source: "export default defineMod({ network: {} });" })).toThrow(/unknown key/);
    expect(() => checkDefinition(null, m.manifest)).toThrow(ValidationError);
  });

  it("hashes content: stable across key order, sensitive to source", async () => {
    const m = loadExample("spin-friendly-chennai");
    const reordered = { source: m.source, manifest: Object.fromEntries(Object.entries(m.manifest).reverse()) as typeof m.manifest };
    const h = await hashBundle(m);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashBundle(reordered)).toBe(h);
    expect(await hashBundle({ ...m, source: m.source + "\n" })).not.toBe(h);
    expect(await hashBundle({ ...m, manifest: { ...m.manifest, version: "1.0.1" } })).not.toBe(h);
  });
});

describe("fingerprints", () => {
  it("matches identical ordered sets and explains differences", () => {
    expect(compareFingerprints(["a@1", "b@2"], ["a@1", "b@2"]).ok).toBe(true);
    expect(compareFingerprints([], []).ok).toBe(true);
    expect(compareFingerprints(["a@1"], []).reason).toMatch(/only you have: a/);
    expect(compareFingerprints([], ["a@1"]).reason).toMatch(/only the other player have: a/);
    expect(compareFingerprints(["a@1"], ["a@2"]).reason).toMatch(/different versions of: a/);
    expect(compareFingerprints(["a@1", "b@2"], ["b@2", "a@1"]).reason).toMatch(/different order/);
  });

  it("ignores UI-only and disabled mods", () => {
    const { runtime } = runtimeWithClock();
    addInline(runtime, "theme", ["ui.theme"], { ui: { theme: {} } });
    addInline(runtime, "eng", ["engine.onBall"], { engine: { onBall: () => {} } });
    expect(runtime.fingerprint()).toEqual(["eng@hash-eng"]);
    runtime.setEnabled("eng", false);
    expect(runtime.fingerprint()).toEqual([]);
  });
});
