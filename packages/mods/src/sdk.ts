/**
 * Mod SDK, version "1".
 *
 * This file is the stable surface a mod is written against. It must stay free of
 * imports and runtime values: `npm run sdk --workspace=packages/mods` copies it
 * verbatim into `sdk/index.d.ts`, which is what the coding agent is given.
 * Additive changes only within an SDK major version; breaking changes bump `sdk`.
 */

export type SdkVersion = "1";

/* ───────────────────────────── Manifest ───────────────────────────── */

export type ModHookName =
  | "data.players"
  | "data.teams"
  | "rules"
  | "engine.ballProbabilities"
  | "engine.onBall"
  | "engine.matchFormat"
  | "ui.theme"
  | "ui.screens"
  | "ui.panels"
  | "commentary.line"
  | "news.item";

export interface ModManifest {
  /** Lowercase slug, 3-64 chars: letters, digits, hyphens. */
  id: string;
  name: string;
  /** Semver string of this mod. */
  version: string;
  sdk: SdkVersion;
  /** Every hook the module implements. Hooks not listed here are never called. */
  hooks: ModHookName[];
  description?: string;
}

/* ───────────────────────────── Engine ───────────────────────────── */

export type BallOutcome = "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball" | "legbye";

/** Probabilities for the next delivery. Sums to 1 on the way in; any non-negative weights are fine on the way out (they are renormalised). */
export type BallProbabilities = Record<BallOutcome, number>;

export type BowlingStyle =
  | "right-arm-fast" | "right-arm-fast-medium" | "right-arm-medium-fast" | "right-arm-medium" | "right-arm-slow"
  | "left-arm-fast" | "left-arm-fast-medium" | "left-arm-medium-fast" | "left-arm-medium" | "left-arm-slow"
  | "off-spin" | "left-arm-orthodox" | "leg-spin" | "left-arm-wrist-spin"
  | "unknown";

export type PitchType = "flat" | "seaming" | "turning" | "balanced";
export type BoundarySize = "small" | "medium" | "large";
export type DewFactor = "none" | "moderate" | "heavy";
export type MatchPhase = "powerplay" | "middle" | "death";

export interface ModPlayerRatings {
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
}

/** Read-only view of a player inside an engine hook. */
export interface BallPlayer {
  id: string;
  name: string;
  role: string;
  isInternational: boolean;
  isWicketKeeper: boolean;
  bowlingStyle: BowlingStyle;
  battingHand: "right" | "left";
  isSpin: boolean;
  isPace: boolean;
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  /** Rolling form, 0-100, 50 is neutral. */
  form: number;
  ratings: ModPlayerRatings;
}

export interface BallVenue {
  /** Stable slug: "chepauk", "wankhede", "chinnaswamy", "eden-gardens", "arun-jaitley", "uppal", "sawai-mansingh", "mohali", "narendra-modi", "ekana", "neutral", or the team id for custom teams. */
  id: string;
  name: string;
  pitch: PitchType;
  boundary: BoundarySize;
  dew: DewFactor;
  /** 1.0 balanced; above 1 favours bowlers. */
  bowlingRating: number;
}

export interface BallContext {
  batter: BallPlayer;
  bowler: BallPlayer;
  /** 0-based over number. */
  over: number;
  /** 1-based legal delivery within the over. */
  ball: number;
  innings: 1 | 2;
  score: number;
  wickets: number;
  /** Runs needed to win in the second innings; 0 in the first. */
  target: number;
  ballsRemaining: number;
  /** Overs in this innings. */
  maxOvers: number;
  phase: MatchPhase;
  venue: BallVenue;
  /** Seeded stream, identical on every multiplayer peer. Never use Math.random. */
  rng: () => number;
}

export interface BallEvent {
  outcome: BallOutcome;
  runs: number;
  extras: number;
  isWicket: boolean;
}

export interface MatchFormat {
  /** Overs per innings (1-50). */
  overs: number;
  /** Powerplay length in overs (0 to `overs`). */
  powerplayOvers: number;
  /** Most overs one bowler may bowl (the format must still be bowlable by 5 bowlers). */
  maxOversPerBowler: number;
  /** Overs in a tie-break super over (1-5). */
  superOverOvers: number;
}

/* ───────────────────────────── Data and rules ───────────────────────────── */

export type PlayerRole = "batsman" | "bowler" | "all-rounder" | "wicket-keeper";

/**
 * A player as stored in a save. Fields not listed here are passed through
 * untouched, so spread (`{ ...p, age: p.age - 2 }`) to keep them.
 */
export interface ModPlayer {
  id: string;
  name: string;
  age: number;
  country: string;
  role: PlayerRole;
  /** Each rating is clamped to 1-99. */
  ratings: ModPlayerRatings;
  isInternational: boolean;
  isWicketKeeper?: boolean;
  bowlingStyle?: BowlingStyle;
  battingHand?: "right" | "left";
  teamId?: string;
  [extra: string]: unknown;
}

export interface ModTeam {
  id: string;
  name: string;
  shortName: string;
  city: string;
  /** "#rgb" or "#rrggbb". */
  primaryColor: string;
  secondaryColor: string;
  stadiumName?: string;
  /** 0.5-1.6, above 1 favours bowlers. */
  stadiumBowlingRating?: number;
  pitchType?: PitchType;
  boundarySize?: BoundarySize;
  dewFactor?: DewFactor;
  /** Player ids in this team's squad. Players listed here move to this team. */
  squad?: string[];
  [extra: string]: unknown;
}

export interface ModRuleSet {
  name: string;
  league: "ipl" | "wpl" | "custom";
  leagueName?: string;
  teamIds: string[];
  impactPlayer: boolean;
  salaryCap: number;
  maxBouncersPerOver: 1 | 2;
  superOverTieBreaker: "boundary-count" | "repeated-super-over";
  maxOverseasInXI: number;
  maxOverseasInSquad: number;
  maxSquadSize: number;
  matchesPerTeam: number;
  playoffTeams: number;
  playoffFormat: "eliminator" | "simple" | "none";
  /** 1.0 normal; below 1 means lower scoring. */
  scoringMultiplier: number;
  injuriesEnabled: boolean;
  gender?: "men" | "women" | "combined";
  playerSource?: "real" | "generated";
  megaAuctionCycle?: number;
  maxRetentions?: number;
  maxMiniRetentions?: number;
}

/* ───────────────────────────── UI ───────────────────────────── */

/**
 * Theme as CSS variables. Names must start with `--th-` (the app's theme tokens,
 * e.g. `--th-body`, `--th-surface`, `--th-text-primary`) or `--mod-`. Values are
 * plain CSS colours, lengths or numbers: no `url()`, braces, semicolons or `@`.
 */
export interface ModTheme {
  /** Applied in both light and dark mode. */
  variables?: Record<string, string>;
  light?: Record<string, string>;
  dark?: Record<string, string>;
  fonts?: {
    /** CSS font-family list, e.g. `"Georgia", serif`. System fonts only. */
    body?: string;
  };
}

/** Read-only snapshot of the game handed to screens and panels. */
export interface ModGameSnapshot {
  seasonNumber: number;
  phase: string;
  userTeamId: string | null;
  rulesName: string;
  teams: { id: string; name: string; shortName: string; wins: number; losses: number; points: number; nrr: number }[];
}

/** A full page at `/mods/screen/<modId>/<screenId>`, rendered in a sandboxed iframe (scripts only, no network-same-origin access). */
export interface ModScreen {
  id: string;
  title: string;
  /** Complete HTML document. Receives `ModHostMessage`s and may post `ModClientMessage`s to `parent`. */
  html: string;
}

export type ModPanelSlot = "team.sidebar" | "match.summary" | "season.header";

/** A widget placed in an existing screen's slot, rendered in a sandboxed iframe. */
export interface ModPanel {
  id: string;
  slot: ModPanelSlot;
  title: string;
  /** Complete HTML document. */
  html: string;
  /** Height in px, 40-600. Default 160. */
  height?: number;
}

/** Messages the app posts into an iframe. */
export type ModHostMessage = { type: "state"; state: ModGameSnapshot };

/** Messages an iframe may post to `parent`. */
export type ModClientMessage =
  | { type: "ready" }
  | { type: "navigate"; to: string }
  | { type: "toast"; text: string };

/* ───────────────────────────── Presentation hooks ───────────────────────────── */

export interface NewsItem {
  title: string;
  body?: string;
}

export interface ModNewsEvent {
  kind: string;
  [detail: string]: unknown;
}

/* ───────────────────────────── Definition ───────────────────────────── */

export interface ModDefinition {
  data?: {
    /** Applied once per save when the mod is first loaded into it. */
    players?(players: ModPlayer[]): ModPlayer[];
    teams?(teams: ModTeam[]): ModTeam[];
  };
  /** Applied once per save when the mod is first loaded into it. */
  rules?(rules: ModRuleSet): ModRuleSet;
  engine?: {
    /** Called for every delivery, after all base adjustments and before sampling. Must be pure and fast (under 20 ms). */
    ballProbabilities?(ctx: BallContext, probs: BallProbabilities): BallProbabilities;
    /** Read-only observer called after each delivery. */
    onBall?(ctx: BallContext, event: BallEvent): void;
    matchFormat?(format: MatchFormat): MatchFormat;
  };
  ui?: {
    theme?: ModTheme;
    screens?: ModScreen[];
    panels?: ModPanel[];
  };
  commentary?: {
    /** Return a replacement commentary line, or null to keep the default. */
    line?(event: BallEvent, ctx: BallContext): string | null;
  };
  news?: {
    item?(event: ModNewsEvent): NewsItem | null;
  };
}
