/**
 * Shape and range checks for everything a mod hands back to the app. Each
 * validator either returns a clean, normalised copy or throws ValidationError;
 * the runtime turns a throw into a skipped call and a strike.
 */

import type {
  BallOutcome, BallProbabilities, MatchFormat, ModHookName, ModManifest, ModPanel, ModPlayer,
  ModPlayerRatings, ModRuleSet, ModScreen, ModTeam, ModTheme,
} from "./sdk.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(message: string): never {
  throw new ValidationError(message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export const HOOK_NAMES: readonly ModHookName[] = [
  "data.players", "data.teams", "rules",
  "engine.ballProbabilities", "engine.onBall", "engine.matchFormat",
  "ui.theme", "ui.screens", "ui.panels",
  "commentary.line", "news.item",
];

/** Hooks that change simulation results; mods using them must match across multiplayer peers. */
export const SIM_HOOKS: readonly ModHookName[] = [
  "data.players", "data.teams", "rules",
  "engine.ballProbabilities", "engine.onBall", "engine.matchFormat",
];

/* ───────────────────────────── Engine outputs ───────────────────────────── */

const OUTCOMES: readonly BallOutcome[] = ["dot", "1", "2", "3", "4", "6", "wicket", "wide", "noball", "legbye"];

/** Finite, non-negative, not all zero; returned renormalised to sum 1. Extra keys are dropped. */
export function validateProbabilities(out: unknown): BallProbabilities {
  if (!isObject(out)) fail("ballProbabilities must return an object");
  const result = {} as BallProbabilities;
  let total = 0;
  for (const key of OUTCOMES) {
    const v = out[key];
    if (!isNum(v)) fail(`probability "${key}" is not a finite number (got ${String(v)})`);
    if (v < 0) fail(`probability "${key}" is negative (${v})`);
    result[key] = v;
    total += v;
  }
  if (!(total > 0) || !Number.isFinite(total)) fail("probabilities sum to zero");
  for (const key of OUTCOMES) result[key] /= total;
  return result;
}

function intIn(v: unknown, lo: number, hi: number, name: string): number {
  if (!isNum(v) || !Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be an integer from ${lo} to ${hi} (got ${String(v)})`);
  return v;
}

export function validateMatchFormat(out: unknown): MatchFormat {
  if (!isObject(out)) fail("matchFormat must return an object");
  const overs = intIn(out.overs, 1, 50, "overs");
  const powerplayOvers = intIn(out.powerplayOvers, 0, overs, "powerplayOvers");
  const maxOversPerBowler = intIn(out.maxOversPerBowler, 1, overs, "maxOversPerBowler");
  const superOverOvers = intIn(out.superOverOvers, 1, 5, "superOverOvers");
  // A side fields at most five bowlers, so the format has to be bowlable by five
  if (Math.ceil(overs / maxOversPerBowler) > 5) fail(`${overs} overs cannot be bowled with ${maxOversPerBowler} per bowler`);
  return { overs, powerplayOvers, maxOversPerBowler, superOverOvers };
}

/* ───────────────────────────── Rules ───────────────────────────── */

type FieldSpec =
  | { t: "string" } | { t: "boolean" } | { t: "strings" }
  | { t: "number"; min: number; max: number; int?: boolean }
  | { t: "enum"; values: (string | number)[] };

const RULE_FIELDS: Record<keyof ModRuleSet, FieldSpec & { optional?: boolean }> = {
  name: { t: "string" },
  league: { t: "enum", values: ["ipl", "wpl", "custom"] },
  leagueName: { t: "string", optional: true },
  teamIds: { t: "strings" },
  impactPlayer: { t: "boolean" },
  salaryCap: { t: "number", min: 1, max: 100000 },
  maxBouncersPerOver: { t: "enum", values: [1, 2] },
  superOverTieBreaker: { t: "enum", values: ["boundary-count", "repeated-super-over"] },
  maxOverseasInXI: { t: "number", min: 0, max: 11, int: true },
  maxOverseasInSquad: { t: "number", min: 0, max: 60, int: true },
  maxSquadSize: { t: "number", min: 11, max: 60, int: true },
  matchesPerTeam: { t: "number", min: 1, max: 100, int: true },
  playoffTeams: { t: "number", min: 0, max: 16, int: true },
  playoffFormat: { t: "enum", values: ["eliminator", "simple", "none"] },
  scoringMultiplier: { t: "number", min: 0.3, max: 2 },
  injuriesEnabled: { t: "boolean" },
  gender: { t: "enum", values: ["men", "women", "combined"], optional: true },
  playerSource: { t: "enum", values: ["real", "generated"], optional: true },
  megaAuctionCycle: { t: "number", min: 1, max: 20, int: true, optional: true },
  maxRetentions: { t: "number", min: 0, max: 25, int: true, optional: true },
  maxMiniRetentions: { t: "number", min: 0, max: 25, int: true, optional: true },
};

export interface RulesValidationOptions {
  /** Team ids `teamIds` may reference beyond the incoming ones (teams added by data.teams, all built-in teams). */
  knownTeamIds?: readonly string[];
}

export function validateRules(out: unknown, base: ModRuleSet, opts: RulesValidationOptions = {}): ModRuleSet {
  if (!isObject(out)) fail("rules must return an object");
  const known = new Set<string>([...base.teamIds, ...(opts.knownTeamIds ?? [])]);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(out)) {
    if (!(key in RULE_FIELDS)) fail(`unknown rule "${key}"`);
  }
  for (const [key, spec] of Object.entries(RULE_FIELDS)) {
    const v = out[key];
    if (v === undefined) {
      if (!spec.optional) fail(`rule "${key}" is missing`);
      continue;
    }
    switch (spec.t) {
      case "string":
        if (typeof v !== "string" || !v.trim() || v.length > 80) fail(`rule "${key}" must be a short non-empty string`);
        break;
      case "boolean":
        if (typeof v !== "boolean") fail(`rule "${key}" must be a boolean`);
        break;
      case "strings":
        if (!Array.isArray(v) || v.length < 2 || !v.every(x => typeof x === "string")) fail(`rule "${key}" must be an array of at least two ids`);
        if (new Set(v).size !== v.length) fail(`rule "${key}" has duplicate ids`);
        for (const id of v as string[]) if (!known.has(id)) fail(`rule "${key}" references unknown team "${id}"`);
        break;
      case "number":
        if (!isNum(v) || v < spec.min || v > spec.max || (spec.int && !Number.isInteger(v))) {
          fail(`rule "${key}" must be ${spec.int ? "an integer" : "a number"} from ${spec.min} to ${spec.max} (got ${String(v)})`);
        }
        break;
      case "enum":
        if (!spec.values.includes(v as string | number)) fail(`rule "${key}" must be one of ${spec.values.join(", ")}`);
        break;
    }
    result[key] = Array.isArray(v) ? [...v] : v;
  }
  const r = result as unknown as ModRuleSet;
  if (r.playoffTeams > 0 && r.playoffTeams >= r.teamIds.length) fail("playoffTeams must be fewer than the number of teams");
  if (r.maxOverseasInXI > r.maxOverseasInSquad) fail("maxOverseasInXI cannot exceed maxOverseasInSquad");
  return r;
}

/* ───────────────────────────── Data ───────────────────────────── */

const ROLES = ["batsman", "bowler", "all-rounder", "wicket-keeper"];
const RATING_KEYS: (keyof ModPlayerRatings)[] = ["battingIQ", "timing", "power", "running", "wicketTaking", "economy", "accuracy", "clutch"];
const BOWLING_STYLES = [
  "right-arm-fast", "right-arm-fast-medium", "right-arm-medium-fast", "right-arm-medium", "right-arm-slow",
  "left-arm-fast", "left-arm-fast-medium", "left-arm-medium-fast", "left-arm-medium", "left-arm-slow",
  "off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin", "unknown",
];

function shortString(v: unknown, name: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(`${name} must be a non-empty string of at most ${max} characters`);
  return v;
}

/** Output must be an array of well-formed players; ratings are clamped to 1-99; extra fields pass through. */
export function validatePlayers(out: unknown): ModPlayer[] {
  if (!Array.isArray(out)) fail("data.players must return an array");
  if (out.length > 5000) fail("too many players");
  const seen = new Set<string>();
  return out.map((raw, i) => {
    const at = `players[${i}]`;
    if (!isObject(raw)) fail(`${at} is not an object`);
    const id = shortString(raw.id, `${at}.id`, 64);
    if (seen.has(id)) fail(`duplicate player id "${id}"`);
    seen.add(id);
    shortString(raw.name, `${at}.name`);
    if (!isNum(raw.age) || raw.age < 14 || raw.age > 60) fail(`${at}.age must be a number from 14 to 60`);
    shortString(raw.country, `${at}.country`, 60);
    if (typeof raw.role !== "string" || !ROLES.includes(raw.role)) fail(`${at}.role must be one of ${ROLES.join(", ")}`);
    if (typeof raw.isInternational !== "boolean") fail(`${at}.isInternational must be a boolean`);
    if (raw.bowlingStyle !== undefined && !BOWLING_STYLES.includes(raw.bowlingStyle as string)) fail(`${at}.bowlingStyle is not a known style`);
    if (raw.battingHand !== undefined && raw.battingHand !== "right" && raw.battingHand !== "left") fail(`${at}.battingHand must be "right" or "left"`);
    if (!isObject(raw.ratings)) fail(`${at}.ratings is missing`);
    const ratings = {} as ModPlayerRatings;
    for (const k of RATING_KEYS) {
      const v = (raw.ratings as Record<string, unknown>)[k];
      if (!isNum(v)) fail(`${at}.ratings.${k} must be a finite number`);
      ratings[k] = Math.min(99, Math.max(1, Math.round(v)));
    }
    return { ...raw, ratings } as ModPlayer;
  });
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function validateTeams(out: unknown): ModTeam[] {
  if (!Array.isArray(out)) fail("data.teams must return an array");
  if (out.length < 2 || out.length > 32) fail("data.teams must return between 2 and 32 teams");
  const seen = new Set<string>();
  return out.map((raw, i) => {
    const at = `teams[${i}]`;
    if (!isObject(raw)) fail(`${at} is not an object`);
    const id = shortString(raw.id, `${at}.id`, 32);
    if (!/^[a-z0-9-]+$/.test(id)) fail(`${at}.id must be lowercase letters, digits and hyphens`);
    if (seen.has(id)) fail(`duplicate team id "${id}"`);
    seen.add(id);
    shortString(raw.name, `${at}.name`);
    shortString(raw.shortName, `${at}.shortName`, 6);
    shortString(raw.city, `${at}.city`, 60);
    for (const c of ["primaryColor", "secondaryColor"] as const) {
      if (typeof raw[c] !== "string" || !HEX.test(raw[c] as string)) fail(`${at}.${c} must be a #rgb or #rrggbb colour`);
    }
    if (raw.stadiumBowlingRating !== undefined && (!isNum(raw.stadiumBowlingRating) || raw.stadiumBowlingRating < 0.5 || raw.stadiumBowlingRating > 1.6)) {
      fail(`${at}.stadiumBowlingRating must be from 0.5 to 1.6`);
    }
    if (raw.pitchType !== undefined && !["flat", "seaming", "turning", "balanced"].includes(raw.pitchType as string)) fail(`${at}.pitchType is invalid`);
    if (raw.boundarySize !== undefined && !["small", "medium", "large"].includes(raw.boundarySize as string)) fail(`${at}.boundarySize is invalid`);
    if (raw.dewFactor !== undefined && !["none", "moderate", "heavy"].includes(raw.dewFactor as string)) fail(`${at}.dewFactor is invalid`);
    if (raw.squad !== undefined && (!Array.isArray(raw.squad) || !raw.squad.every(x => typeof x === "string"))) fail(`${at}.squad must be an array of player ids`);
    return { ...raw } as ModTeam;
  });
}

/* ───────────────────────────── Static content ───────────────────────────── */

const VAR_NAME = /^--(?:th|mod)-[a-z0-9-]{1,40}$/;
const CSS_VALUE = /^[#a-zA-Z0-9\s.,%()+\-/'"]{1,120}$/;
const CSS_DENY = /url\s*\(|expression|import|javascript|image-set|element\s*\(|paint\s*\(|attr\s*\(/i;

function cssValue(v: unknown, name: string): string {
  if (typeof v !== "string" || !CSS_VALUE.test(v) || CSS_DENY.test(v)) fail(`${name} is not a plain CSS value`);
  return v;
}

function cssVars(v: unknown, name: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(`${name} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!VAR_NAME.test(k)) fail(`${name}: "${k}" must be a --th-* or --mod-* variable`);
    out[k] = cssValue(val, `${name}.${k}`);
  }
  return out;
}

export function validateTheme(theme: unknown): ModTheme {
  if (!isObject(theme)) fail("ui.theme must be an object");
  const out: ModTheme = {};
  const variables = cssVars(theme.variables, "theme.variables");
  const light = cssVars(theme.light, "theme.light");
  const dark = cssVars(theme.dark, "theme.dark");
  if (variables) out.variables = variables;
  if (light) out.light = light;
  if (dark) out.dark = dark;
  if (theme.fonts !== undefined) {
    if (!isObject(theme.fonts)) fail("theme.fonts must be an object");
    out.fonts = {};
    if (theme.fonts.body !== undefined) out.fonts.body = cssValue(theme.fonts.body, "theme.fonts.body");
  }
  return out;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_HTML = 500_000;
const SLOTS = ["team.sidebar", "match.summary", "season.header"];

export function validateScreens(screens: unknown): ModScreen[] {
  if (!Array.isArray(screens) || screens.length > 20) fail("ui.screens must be an array of at most 20 screens");
  const seen = new Set<string>();
  return screens.map((s, i) => {
    if (!isObject(s)) fail(`screens[${i}] is not an object`);
    const id = shortString(s.id, `screens[${i}].id`, 64);
    if (!SLUG.test(id)) fail(`screens[${i}].id must be a slug`);
    if (seen.has(id)) fail(`duplicate screen id "${id}"`);
    seen.add(id);
    const title = shortString(s.title, `screens[${i}].title`);
    if (typeof s.html !== "string" || !s.html.trim() || s.html.length > MAX_HTML) fail(`screens[${i}].html must be an HTML string under 500 KB`);
    return { id, title, html: s.html };
  });
}

export function validatePanels(panels: unknown): ModPanel[] {
  if (!Array.isArray(panels) || panels.length > 20) fail("ui.panels must be an array of at most 20 panels");
  const seen = new Set<string>();
  return panels.map((p, i) => {
    if (!isObject(p)) fail(`panels[${i}] is not an object`);
    const id = shortString(p.id, `panels[${i}].id`, 64);
    if (!SLUG.test(id)) fail(`panels[${i}].id must be a slug`);
    if (seen.has(id)) fail(`duplicate panel id "${id}"`);
    seen.add(id);
    if (typeof p.slot !== "string" || !SLOTS.includes(p.slot)) fail(`panels[${i}].slot must be one of ${SLOTS.join(", ")}`);
    const title = shortString(p.title, `panels[${i}].title`);
    if (typeof p.html !== "string" || !p.html.trim() || p.html.length > MAX_HTML) fail(`panels[${i}].html must be an HTML string under 500 KB`);
    let height = 160;
    if (p.height !== undefined) {
      if (!isNum(p.height) || p.height < 40 || p.height > 600) fail(`panels[${i}].height must be from 40 to 600`);
      height = Math.round(p.height);
    }
    return { id, slot: p.slot as ModPanel["slot"], title, html: p.html, height };
  });
}

/* ───────────────────────────── Manifest ───────────────────────────── */

export function validateManifest(m: unknown): ModManifest {
  if (!isObject(m)) fail("manifest must be an object");
  const id = shortString(m.id, "manifest.id", 64);
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(id)) fail("manifest.id must be 3-64 lowercase letters, digits or hyphens");
  const name = shortString(m.name, "manifest.name");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) fail("manifest.version must be a semver string");
  if (m.sdk !== "1") fail(`unsupported SDK version ${JSON.stringify(m.sdk)}; this app supports "1"`);
  if (!Array.isArray(m.hooks) || m.hooks.length === 0) fail("manifest.hooks must list at least one hook");
  for (const h of m.hooks) if (!HOOK_NAMES.includes(h as ModHookName)) fail(`unknown hook "${String(h)}"`);
  if (new Set(m.hooks).size !== m.hooks.length) fail("manifest.hooks has duplicates");
  const manifest: ModManifest = { id, name, version: m.version, sdk: "1", hooks: [...(m.hooks as ModHookName[])] };
  if (m.description !== undefined) {
    if (typeof m.description !== "string" || m.description.length > 500) fail("manifest.description must be a string of at most 500 characters");
    manifest.description = m.description;
  }
  return manifest;
}
