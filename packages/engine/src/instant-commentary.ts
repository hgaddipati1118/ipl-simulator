/**
 * Model (real-corpus) commentary for instantly simulated matches, generated lazily when a match is viewed.
 *
 * The instant engine (match.ts) writes short built-in lines so a season sims fast; the live viewer writes every ball with
 * generateDeliveryCommentary (corpus lines, docs/COMMENTARY.md). To give an instant match the same commentary without
 * paying for it on every simulated match:
 *
 *  1. at simulation time `attachCommentaryCues(result, players, gender)` stores the few facts the detailed ball log lacks
 *     (non-striker, the extras split, boundary / overthrow, wide kind, second fielder, substitute, fielding note) as a
 *     compact `commentaryCues` field on `result.detailed` (copying fields only: no text is generated);
 *  2. when the match page opens its commentary, `withModelCommentary(detailed)` rebuilds each delivery and asks
 *     generateDeliveryCommentary for a line. A ball takes the new line only when the corpus model supplied it (the result
 *     has a key); special deliveries keep their hand-written line and a missed-chance ball keeps its fielding line.
 *
 * Seeded per match and ball, never touches the simulation's RNG, and never changes runs, wickets or anything but the
 * `commentary` strings. Without a loaded model, or for matches stored before cues existed, the detailed result is
 * returned unchanged.
 */
import type { BallEvent, DetailedBallEvent, DetailedMatchResult, MatchResult } from "./match.js";
import type { Player } from "./player.js";
import type { FieldingNote } from "./fielding.js";
import { isBowlerWicket, type DeliveryDetail, type DismissalKind, type Gender } from "./delivery-rules.js";
import { generateDeliveryCommentary } from "./commentary.js";
import { commentarySeed, hasCommentaryModel } from "./commentary-model.js";
import { createRNG } from "./rng.js";

/** What one delivery needs beyond its DetailedBallEvent. Short keys, defaults omitted: it is stored with every match. */
export interface BallCommentaryCue {
  /** non-striker's name */
  ns?: string;
  /** extras split: wides, no-balls, byes, leg byes, penalty */
  wd?: number;
  nb?: number;
  by?: number;
  lb?: number;
  pen?: number;
  /** bat boundary (4 / 6) */
  bd?: 4 | 6;
  /** overthrow boundary runs */
  ot?: number;
  /** runs physically run */
  rr?: number;
  wk?: "off" | "leg" | "height";
  /** the non-striker was out (run out at his end) */
  nso?: 1;
  /** fielder who made the dismissal (only when a real player of the match; the detailed log may name a position) */
  f?: string;
  f2?: string;
  sub?: 1;
  /** no ball bowled (Mankad) */
  dead?: 1;
  note?: FieldingNote;
}

export interface CommentaryCues {
  v: 1;
  gender: Gender;
  /** bowling style / batting hand by player name */
  players: Record<string, { s?: string; h?: string }>;
  /** one per entry of detailed.ballLog, same order */
  balls: BallCommentaryCue[];
}

/** A detailed result that may carry cues (old saves and live-viewed matches do not) */
export type DetailedWithCues = DetailedMatchResult & { commentaryCues?: CommentaryCues };

function cueFor(ev: BallEvent, name: (id?: string) => string | undefined): BallCommentaryCue {
  const c: BallCommentaryCue = {};
  const ns = name(ev.nonStriker);
  if (ns) c.ns = ns;
  if (ev.wides) c.wd = ev.wides;
  if (ev.noBalls) c.nb = ev.noBalls;
  if (ev.byes) c.by = ev.byes;
  if (ev.legByes) c.lb = ev.legByes;
  if (ev.penaltyRuns) c.pen = ev.penaltyRuns;
  if (ev.boundary) c.bd = ev.boundary;
  if (ev.overthrow) c.ot = ev.overthrow;
  if (ev.runsRun) c.rr = ev.runsRun;
  if (ev.wideKind) c.wk = ev.wideKind;
  if (ev.isWicket && ev.playerOutId && ev.playerOutId !== ev.batter) c.nso = 1;
  const f = name(ev.fielderId);
  if (f) c.f = f;
  const f2 = name(ev.fielder2Id);
  if (f2) c.f2 = f2;
  if (ev.substitute) c.sub = 1;
  if (ev.deadBall) c.dead = 1;
  if (ev.fieldingNote) c.note = ev.fieldingNote;
  return c;
}

/**
 * Store commentary cues on `result.detailed` (no-op without a detailed result, or when its ball log does not line up
 * with the two innings' logs). `players`: everyone who could appear (both squads).
 */
export function attachCommentaryCues(result: MatchResult, players: readonly Player[], gender: Gender): void {
  const detailed = result.detailed as DetailedWithCues | undefined;
  if (!detailed) return;
  const events = [...result.innings[0].ballLog, ...result.innings[1].ballLog];
  if (events.length !== detailed.ballLog.length) return;
  const byId = new Map(players.map(p => [p.id, p]));
  const name = (id?: string) => (id ? byId.get(id)?.name : undefined);
  const roster: CommentaryCues["players"] = {};
  for (const ev of events) {
    for (const id of [ev.batter, ev.bowler, ev.nonStriker]) {
      const p = id ? byId.get(id) : undefined;
      if (p && !roster[p.name]) roster[p.name] = { ...(p.bowlingStyle ? { s: p.bowlingStyle } : {}), ...(p.battingHand ? { h: p.battingHand } : {}) };
    }
  }
  detailed.commentaryCues = { v: 1, gender, players: roster, balls: events.map(ev => cueFor(ev, name)) };
}

const EVENT_OUTCOME: Record<DetailedBallEvent["eventType"], DeliveryDetail["outcome"]> = {
  dot: "dot", single: "1", double: "2", triple: "3", four: "4", six: "6", wicket: "wicket", wide: "wide", noball: "noball", legbye: "legbye",
};

/** The delivery as the engine produced it, rebuilt from the ball log entry and its cue */
function rebuildDelivery(ball: DetailedBallEvent, c: BallCommentaryCue): DeliveryDetail {
  const outcome = EVENT_OUTCOME[ball.eventType] ?? "dot";
  const detail: DeliveryDetail = {
    outcome,
    legal: outcome !== "wide" && outcome !== "noball" && !c.dead,
    batRuns: ball.runs,
    batBoundary: c.bd ?? 0,
    wides: c.wd ?? 0,
    noBalls: c.nb ?? 0,
    byes: c.by ?? 0,
    legByes: c.lb ?? 0,
    penalty: c.pen ?? 0,
    extras: ball.extras,
    runsRun: c.rr ?? 0,
    overthrow: c.ot ?? 0,
    freeHitNext: false,
  };
  if (c.wk) detail.wideKind = c.wk;
  if (ball.wicketType) {
    const kind = ball.wicketType as DismissalKind;
    detail.dismissal = {
      kind, out: c.nso ? "nonStriker" : "striker", substitute: !!c.sub, bowlerCredit: isBowlerWicket(kind), newBatterFaces: false,
    };
  }
  return detail;
}

/**
 * The detailed result with corpus commentary for every ball the model can describe. Returns the same object when there
 * is nothing to do (no model loaded, no cues). Pure: the input is not modified.
 */
export function withModelCommentary(detailed: DetailedMatchResult): DetailedMatchResult {
  const cues = (detailed as DetailedWithCues).commentaryCues;
  if (!cues || cues.v !== 1 || cues.balls.length !== detailed.ballLog.length || !hasCommentaryModel()) return detailed;
  const used: Record<string, 1> = {};
  const batter = new Map<string, { runs: number; balls: number }>();
  const legalInOver = new Map<string, number>();
  const target = detailed.innings1.totalRuns + 1;
  let changed = false;

  const ballLog = detailed.ballLog.map((ball, i) => {
    const c = cues.balls[i];
    const detail = rebuildDelivery(ball, c);
    const bKey = `${ball.innings}|${ball.batterName}`;
    const bs = batter.get(bKey) ?? { runs: 0, balls: 0 };
    const oKey = `${ball.innings}|${ball.over}`;
    const legalBefore = legalInOver.get(oKey) ?? 0;
    // advance the running counts whatever happens to the text
    batter.set(bKey, { runs: bs.runs + ball.runs, balls: bs.balls + (detail.legal || detail.outcome === "noball" ? 1 : 0) });
    if (detail.legal) legalInOver.set(oKey, legalBefore + 1);

    // keep: a missed chance (its fielding line says what happened), the Mankad, anything carrying a review
    if ((c.note && !ball.wicketType) || c.dead || /\bDRS\b/i.test(ball.commentary)) return ball;

    const scoreBefore = ball.scoreSoFar - ball.runs - ball.extras;
    const wicketsBefore = ball.wicketsSoFar - (ball.wicketType ? 1 : 0);
    const rng = createRNG(commentarySeed(detailed.matchId, detailed.homeTeamId, detailed.awayTeamId, ball.innings, i, ball.over, scoreBefore, wicketsBefore));
    const r = generateDeliveryCommentary({
      detail,
      bowlerName: ball.bowlerName,
      batterName: ball.batterName,
      nonStrikerName: c.ns,
      fielderName: c.f,
      fielder2Name: c.f2,
      substitute: !!c.sub,
      freeHit: !!ball.freeHit,
      over: ball.over,
      ball: legalBefore + 1,
      score: scoreBefore,
      wickets: wicketsBefore,
      isSecondInnings: ball.innings === 2,
      target: ball.innings === 2 ? target : undefined,
      bowlingStyle: cues.players[ball.bowlerName]?.s,
      battingHand: cues.players[ball.batterName]?.h,
      gender: cues.gender,
      batterRuns: bs.runs,
      batterBalls: bs.balls,
      rng,
      usedLines: used,
    });
    if (!r.key) return ball;
    used[r.key] = 1;
    changed = true;
    return { ...ball, commentary: r.text };
  });

  return changed ? { ...detailed, ballLog } : detailed;
}
