/**
 * View model for the live Test screen and the Test scorecard (docs/FORMATS.md, Test section): score lines, the state of play, the
 * partnership, the last balls, the commentary feed with its day / session / innings markers, and the wording of every
 * decision. Pure functions of the engine's TestMatchState, so the page stays thin and this file is unit-tested.
 */

import {
  currentTestInnings, oversLeftInMatch, testLead, testTarget,
  type TestBallEvent, type TestInnings, type TestMatchEvent, type TestMatchState, type TestPendingDecision,
} from "@ipl-sim/engine";

export const oversText = (balls: number) => `${Math.floor(balls / 6)}${balls % 6 ? "." + (balls % 6) : ""}`;

export function playerName(st: TestMatchState, id: string | undefined): string {
  return id ? st.players[id]?.name ?? id : "";
}

/** Short name of a team in the match */
/**
 * A team colour readable as text on both themes: a near-black primary (New Zealand) is lightened and a pale one (Australia's
 * yellow) darkened, toward white or black, until its relative luminance is within 0.15-0.45; the hue is kept.
 */
export function readableTeamColor(hex: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1].length === 3 ? m[1].split("").map(c => c + c).join("") : m[1];
  const rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  const lum = (c: number[]) => {
    const lin = c.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const mix = (to: number, t: number) => rgb.map(v => Math.round(v + (to - v) * t));
  let out = rgb;
  for (let t = 0.05; t <= 1 && lum(out) < 0.15; t += 0.05) out = mix(255, t);
  for (let t = 0.05; t <= 1 && lum(out) > 0.45; t += 0.05) out = mix(0, t);
  return `#${out.map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

export function teamShort(st: TestMatchState, teamId: string): string {
  return st.teams[teamId]?.shortName ?? teamId;
}

/** One innings as a score: "312", "245/4", "401/7d", "120/3" (in progress) */
export function inningsScore(inn: TestInnings): string {
  const all = inn.closed === "all_out" || inn.wickets >= 10;
  return `${inn.runs}${all ? "" : "/" + inn.wickets}${inn.closed === "declared" ? "d" : ""}`;
}

/** A team's innings in the match: "312 & 245/4", with (f/o) after a follow-on */
export function teamScoreLine(st: TestMatchState, teamId: string): string {
  const inns = st.innings.filter(i => i.battingTeamId === teamId);
  if (inns.length === 0) return "yet to bat";
  return inns.map(i => inningsScore(i) + (i.followOn ? " (f/o)" : "")).join(" & ");
}

export interface Partnership { runs: number; balls: number; batters: [string, string] }

/** The current partnership: runs and legal balls since the last wicket */
export function partnership(inn: TestInnings): Partnership {
  let runs = 0, balls = 0;
  for (let i = inn.ballLog.length - 1; i >= 0; i--) {
    const ev = inn.ballLog[i];
    if (ev.isWicket) break;
    runs += ev.runs + ev.extras;
    if (ev.outcome !== "wide" && ev.outcome !== "noball") balls++;
  }
  return { runs, balls, batters: [inn.strikerId, inn.nonStrikerId] };
}

const SESSIONS = ["Morning session", "Afternoon session", "Evening session"] as const;

/** "Day 2 · Afternoon session" */
export function sessionLabel(st: TestMatchState): string {
  return `Day ${st.day} · ${SESSIONS[st.session - 1]}`;
}

/** The state of play in one line: who leads, the target, the result */
export function statusLine(st: TestMatchState): string {
  if (st.result) return st.result.text;
  if (!st.toss) return "Toss to come";
  const inn = currentTestInnings(st);
  if (!inn) return "";
  const bat = st.teams[inn.battingTeamId].name;
  if (inn.number === 1) return `${bat} batting first`;
  const target = testTarget(st);
  if (target !== undefined) {
    const need = target - inn.runs;
    return `${bat} need ${need} to win · ${Math.max(0, Math.round(oversLeftInMatch(st)))} overs left in the match`;
  }
  const lead = testLead(st);
  if (lead > 0) return `${bat} lead by ${lead}`;
  if (lead < 0) return `${bat} trail by ${-lead}`;
  return "Scores level";
}

export type ChipKind = "wicket" | "four" | "six" | "extra" | "dot" | "run";

/** The little ball marker: W, 4, 6, 1, 2, ·, 1wd, nb, 2lb */
export function ballChip(ev: TestBallEvent): { label: string; kind: ChipKind } {
  if (ev.isWicket) return { label: "W", kind: "wicket" };
  if (ev.outcome === "wide") return { label: `${ev.wides ?? 1}wd`, kind: "extra" };
  if (ev.outcome === "noball") return { label: `nb${ev.runs ? ev.runs : ""}`, kind: "extra" };
  if (ev.outcome === "legbye") return { label: `${ev.extras}${ev.byes ? "b" : "lb"}`, kind: "extra" };
  if (ev.boundary === 6) return { label: "6", kind: "six" };
  if (ev.boundary === 4) return { label: "4", kind: "four" };
  if (ev.runs === 0) return { label: "·", kind: "dot" };
  return { label: String(ev.runs), kind: "run" };
}

/** The last `n` deliveries of the innings, oldest first */
export function recentBalls(inn: TestInnings | undefined, n = 12): TestBallEvent[] {
  return inn ? inn.ballLog.slice(-n) : [];
}

export type FeedItem =
  | { kind: "ball"; key: string; inn: number; ev: TestBallEvent; label: string }
  | { kind: "event"; key: string; event: TestMatchEvent }
  | { kind: "innings"; key: string; text: string };

/** "Ind 2nd innings" */
function inningsHeading(st: TestMatchState, inn: TestInnings): string {
  const ord = ["1st", "2nd"][st.innings.filter(i => i.battingTeamId === inn.battingTeamId).indexOf(inn)] ?? "";
  return `${st.teams[inn.battingTeamId].name} ${ord} innings${inn.followOn ? " (following on)" : ""}`;
}

/**
 * The commentary feed, newest first: deliveries (with their over.ball), the match events (stumps, lunch, rain, the new ball,
 * declarations, the follow-on, a nightwatchman, the result) placed where they happened, and an innings heading at each start.
 * `limit` caps the deliveries shown (a Test has ~1,800).
 */
export function buildFeed(st: TestMatchState, limit = 150): FeedItem[] {
  const out: FeedItem[] = [];
  const events = [...st.events];
  // events of an innings, by the over they happened at
  const byInn = new Map<number, TestMatchEvent[]>();
  for (const e of events) {
    if (e.kind === "toss") continue;
    (byInn.get(e.inn) ?? byInn.set(e.inn, []).get(e.inn)!).push(e);
  }
  let shown = 0;
  for (let i = st.innings.length - 1; i >= 0 && shown < limit; i--) {
    const inn = st.innings[i];
    const evs = (byInn.get(inn.number) ?? []).slice();
    // events after the last ball (innings end, stumps, result) first
    const lastOver = inn.ballLog.length ? inn.ballLog[inn.ballLog.length - 1].over + 1 : 0;
    const pushEventsFrom = (fromOver: number) => {
      for (let k = evs.length - 1; k >= 0; k--) {
        if (evs[k].overs >= fromOver) {
          out.push({ kind: "event", key: `e${inn.number}-${k}`, event: evs[k] });
          evs.splice(k, 1);
        }
      }
    };
    pushEventsFrom(lastOver);
    for (let b = inn.ballLog.length - 1; b >= 0 && shown < limit; b--) {
      const ev = inn.ballLog[b];
      out.push({ kind: "ball", key: `b${inn.number}-${b}`, inn: inn.number, ev, label: `${ev.over}.${ev.ball}` });
      shown++;
      const prev = inn.ballLog[b - 1];
      if (!prev || prev.over !== ev.over) pushEventsFrom(ev.over);
    }
    if (shown < limit || i === 0) {
      pushEventsFrom(0);
      out.push({ kind: "innings", key: `i${inn.number}`, text: inningsHeading(st, inn) });
    }
  }
  if (shown < limit) {
    const toss = events.find(e => e.kind === "toss");
    if (toss) out.push({ kind: "event", key: "toss", event: toss });
  }
  return out;
}

export interface DecisionView {
  title: string;
  subtitle: string;
  options: { value: string; label: string; hint?: string; primary?: boolean }[];
}

/** The wording of a pending decision for the user */
export function decisionView(st: TestMatchState, p: TestPendingDecision): DecisionView {
  const c = p.context ?? {};
  const team = st.teams[p.teamId]?.name ?? "";
  switch (p.type) {
    case "toss":
      return { title: "You won the toss", subtitle: `${team} won the toss. Bat or bowl?`, options: [
        { value: "bat", label: "Bat first", primary: true }, { value: "bowl", label: "Bowl first" }] };
    case "follow_on":
      return { title: "Enforce the follow-on?", subtitle: `You lead by ${c.lead} on first innings, ${c.oversLeft} overs left in the match.`, options: [
        { value: "enforce", label: "Enforce", hint: "They bat again now", primary: true }, { value: "bat", label: "Bat again", hint: "Rest the bowlers, set a target" }] };
    case "new_ball":
      return { title: "New ball available", subtitle: "80 overs have been bowled with this ball.", options: [
        { value: "take", label: "Take the new ball", primary: true }, { value: "wait", label: "Keep the old ball", hint: "You can take it later" }] };
    case "drs_batting":
      return { title: "Review?", subtitle: `${playerName(st, c.batterId)} is given out ${c.kind === "lbw" ? "lbw" : "caught behind"}. ${c.reviewsLeft} review${c.reviewsLeft === 1 ? "" : "s"} left. Batter's feel: ${Math.round((1 - (c.confidence ?? 0.5)) * 100)}% not out.`, options: [
        { value: "review", label: "Review", primary: true }, { value: "accept", label: "Walk off" }] };
    case "drs_fielding":
      return { title: "Review?", subtitle: `Not out ${c.kind === "lbw" ? "lbw" : "caught behind"} against ${playerName(st, c.batterId)}. ${c.reviewsLeft} review${c.reviewsLeft === 1 ? "" : "s"} left. The bowler is ${Math.round((c.confidence ?? 0.5) * 100)}% sure.`, options: [
        { value: "review", label: "Review", primary: true }, { value: "decline", label: "Don't review" }] };
    case "next_batter": {
      const nw = c.nightwatchman;
      const options = p.options.map(id => ({
        value: id, label: playerName(st, id) + (id === nw ? " (nightwatchman)" : ""),
        hint: id === c.suggested ? "Next in the order" : id === nw ? "Sees out the day" : st.players[id]?.role,
        primary: id === (nw ?? c.suggested),
      }));
      return {
        title: nw ? "Send a nightwatchman?" : "Next batter",
        subtitle: nw ? `A wicket with ${c.oversLeft} overs left today. Protect the next batter with a tail-ender?` : "Who goes in next?",
        options,
      };
    }
  }
}

/** The user's side is batting / fielding in the current innings */
export function userBatting(st: TestMatchState): boolean {
  const inn = currentTestInnings(st);
  return !!inn && !!st.userTeamId && inn.battingTeamId === st.userTeamId && st.status !== "completed";
}

export function userFielding(st: TestMatchState): boolean {
  const inn = currentTestInnings(st);
  return !!inn && !!st.userTeamId && inn.bowlingTeamId === st.userTeamId && st.status !== "completed";
}

export function canDeclare(st: TestMatchState): boolean {
  const inn = currentTestInnings(st);
  return userBatting(st) && !!inn && inn.number < 4 && st.status === "in_progress";
}

/** A bowler's figures: "18-4-52-3" */
export function bowlerFigures(inn: TestInnings, id: string): string {
  const l = inn.bowlers[id];
  if (!l) return "0-0-0-0";
  return `${oversText(l.balls)}-${l.maidens}-${l.runs}-${l.wickets}`;
}
