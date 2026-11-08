/**
 * The live Test scoreboard: day and session, overs today and left, the score with both sides' innings, lead or target, the
 * batters and the partnership, the bowlers at each end with their figures and spells, reviews, the ball's age / new ball due,
 * and the last deliveries.
 */

import { currentTestInnings, oversLeftInMatch, type TestMatchState } from "@ipl-sim/engine";
import {
  ballChip, bowlerFigures, oversText, partnership, playerName, recentBalls, sessionLabel, statusLine, teamScoreLine, type ChipKind,
} from "./test-view";

const CHIP: Record<ChipKind, string> = {
  wicket: "bg-red-500/20 text-red-400",
  four: "bg-emerald-500/20 text-emerald-400",
  six: "bg-amber-500/20 text-amber-400",
  extra: "bg-sky-500/15 text-sky-400",
  dot: "bg-th-hover text-th-faint",
  run: "bg-th-hover text-th-secondary",
};

export function BallChip({ label, kind }: { label: string; kind: ChipKind }) {
  return (
    <span className={`inline-flex h-6 min-w-6 px-1 items-center justify-center rounded-full text-[10px] font-mono font-bold ${CHIP[kind]}`}>
      {label}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-th-muted uppercase tracking-wider font-display">{label}</div>
      <div className={`font-display font-bold stat-num ${accent ?? "text-th-primary"}`}>{value}</div>
    </div>
  );
}

export function TestScoreboard({ st, colors }: { st: TestMatchState; colors: Record<string, string> }) {
  const inn = currentTestInnings(st);
  if (!inn) {
    return (
      <div className="rounded-2xl border border-th bg-th-raised px-6 py-8 text-center" data-testid="test-scoreboard">
        <div className="font-display text-th-secondary">{statusLine(st)}</div>
      </div>
    );
  }
  const bat = st.teams[inn.battingTeamId];
  const bowl = st.teams[inn.bowlingTeamId];
  const pship = partnership(inn);
  const ballAge = Math.floor(inn.legalBalls / 6) - inn.ballTakenAt;
  const overs = Math.floor(inn.legalBalls / 6);
  const rate = inn.legalBalls > 0 ? ((6 * inn.runs) / inn.legalBalls).toFixed(2) : "0.00";
  const left = Math.max(0, st.dayCap - st.dayBalls / 6);
  const batter = (id: string, striker: boolean) => {
    const b = inn.batters[id];
    if (!id || !b) return null;
    return (
      <span key={id} className={`font-mono ${striker ? "text-th-primary font-semibold" : "text-th-secondary"}`} data-testid="test-batter">
        {playerName(st, id)}{striker ? "*" : ""} <span className="text-th-muted">{b.runs}({b.balls})</span>
        {(b.fours > 0 || b.sixes > 0) && <span className="text-th-faint text-[10px] ml-1">{b.fours}x4 {b.sixes}x6</span>}
      </span>
    );
  };
  const bowlerLine = (id: string | null, current: boolean) => {
    if (!id) return null;
    const l = inn.bowlers[id];
    return (
      <span key={id} className={`font-mono ${current ? "text-th-primary font-semibold" : "text-th-secondary"}`}>
        {playerName(st, id)}{current ? " (bowling)" : ""} <span className="text-th-muted">{bowlerFigures(inn, id)}</span>
        {l && l.spellOvers > 0 && <span className="text-th-faint text-[10px] ml-1">spell {l.spellOvers}</span>}
      </span>
    );
  };
  return (
    <div className="rounded-2xl overflow-hidden border border-th" data-testid="test-scoreboard">
      <div className="flex items-stretch">
        <div className="flex-1 px-4 py-2 text-center text-xs font-display font-bold tracking-wide"
          style={{ background: `linear-gradient(135deg, ${colors[bat.id] ?? "#f97316"}30, ${colors[bat.id] ?? "#f97316"}10)`, color: colors[bat.id], borderBottom: `2px solid ${colors[bat.id] ?? "#f97316"}` }}>
          {bat.shortName} — BATTING
        </div>
        <div className="flex-1 px-4 py-2 text-center text-xs font-display font-medium tracking-wide text-th-muted"
          style={{ background: `linear-gradient(135deg, ${colors[bowl.id] ?? "#64748b"}15, transparent)`, borderBottom: `1px solid ${colors[bowl.id] ?? "#64748b"}40` }}>
          {bowl.shortName} — BOWLING
        </div>
      </div>

      <div className="px-4 py-1.5 bg-th-body/60 text-center border-b border-th/30 flex flex-wrap justify-center gap-x-3 text-[11px] text-th-muted font-display">
        <span className="text-th-secondary font-semibold" data-testid="test-session">{sessionLabel(st)}</span>
        <span>{st.venueName}</span>
        <span>{oversText(st.dayBalls)} overs today, {left.toFixed(left % 1 ? 1 : 0)} left</span>
        <span>{Math.round(oversLeftInMatch(st))} left in the match</span>
      </div>

      <div className="bg-th-raised px-4 sm:px-6 py-4">
        <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-6">
          <div className="flex-1 text-center sm:text-left">
            <div className="flex items-baseline gap-2 justify-center sm:justify-start">
              <span className="text-xs font-display font-bold uppercase tracking-wider mr-1" style={{ color: colors[bat.id] }}>{bat.shortName}</span>
              <span className="text-4xl sm:text-5xl font-display font-extrabold text-th-primary stat-num tracking-tight" data-testid="test-score">
                {inn.runs}<span className="text-th-muted">/</span>{inn.wickets}
              </span>
              <span className="text-base text-th-muted font-display">({oversText(inn.legalBalls)} ov)</span>
            </div>
            <div className="text-sm text-th-muted mt-1 font-display">
              {st.teamOrder.map(id => (
                <span key={id} className="mr-3"><span style={{ color: colors[id] }}>{st.teams[id].shortName}</span> {teamScoreLine(st, id)}</span>
              ))}
            </div>
            <div className="text-sm font-display font-semibold text-amber-400 mt-1" data-testid="test-status">{statusLine(st)}</div>
          </div>
          <div className="flex gap-4 sm:gap-6">
            <Stat label="Run rate" value={rate} />
            <Stat label="Partnership" value={`${pship.runs} (${pship.balls})`} />
            <Stat label="Innings" value={`${inn.number}/4`} accent="text-th-secondary" />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-th pt-3 text-xs sm:text-sm">
          {batter(inn.strikerId, true)}
          {batter(inn.nonStrikerId, false)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
          {bowlerLine(inn.ends[inn.end] ?? null, inn.overBalls > 0)}
          {bowlerLine(inn.ends[inn.end === 0 ? 1 : 0] ?? null, false)}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] font-display">
          <span className={`px-2 py-0.5 rounded-full border ${inn.newBallDue ? "border-amber-500/50 bg-amber-500/10 text-amber-400 font-semibold" : "border-th text-th-muted"}`} data-testid="test-ball-age">
            {inn.newBallDue ? "New ball due" : `Ball ${ballAge} ov old${ballAge < 80 ? ` · new ball in ${80 - ballAge}` : ""}`}
          </span>
          <span className="px-2 py-0.5 rounded-full border border-th text-th-muted">
            Reviews: {bat.shortName} {inn.drs.batting} · {bowl.shortName} {inn.drs.fielding}
          </span>
          {overs > 0 && <span className="text-th-faint">{inn.newBalls > 1 ? `${inn.newBalls - 1} new ball${inn.newBalls > 2 ? "s" : ""} taken` : ""}</span>}
          <div className="flex flex-wrap gap-1 ml-auto" data-testid="test-recent">
            {recentBalls(inn).map((ev, i) => { const c = ballChip(ev); return <BallChip key={i} label={c.label} kind={c.kind} />; })}
          </div>
        </div>
      </div>
    </div>
  );
}
