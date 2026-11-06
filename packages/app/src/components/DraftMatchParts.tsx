/**
 * Building blocks for Draft Match (single player and multiplayer):
 * lineup editor, match viewer (the existing live-match page) and the shareable result card.
 */

import { useMemo, useState } from "react";
import { createMatchState, type DraftPlayer, type MatchState } from "@ipl-sim/engine";
import { LiveMatchPage } from "../pages/LiveMatchPage";
import { ovrColorClass, roleLabel } from "../ui-utils";
import { autoLineup, draftMatchRules, draftMatchXIProblems, type DraftMatchLineup, type DraftMatchResultSummary } from "../draft-pools";
import { teamsFromMatchStart } from "../multiplayer/draft-room";
import type { DraftMatchStart, DraftSeries } from "../multiplayer/protocol";

/** Live-match storage namespace for Draft Match games (keeps them apart from season matches). */
export const DRAFT_MATCH_SEASON_KEY = -1;

// ── Lineup editor ───────────────────────────────────────────────────────

export function LineupEditor({ players, onConfirm, confirmLabel = "Confirm lineup", maxOverseasInXI, disabled }: {
  players: DraftPlayer[];
  onConfirm: (lineup: DraftMatchLineup) => void;
  confirmLabel?: string;
  maxOverseasInXI?: number;
  disabled?: boolean;
}) {
  const initial = useMemo(() => autoLineup(players), [players]);
  const [order, setOrder] = useState<string[]>(initial.battingOrder);
  const [captainId, setCaptainId] = useState(initial.captainId);
  const byId = useMemo(() => new Map(players.map(p => [p.id, p])), [players]);
  const problems = draftMatchXIProblems(players, maxOverseasInXI);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  return (
    <div className="rounded-2xl border border-th bg-th-surface p-5" data-testid="lineup-editor">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-display font-semibold text-th-primary">Batting order & captain</h3>
        <button onClick={() => { const a = autoLineup(players); setOrder(a.battingOrder); setCaptainId(a.captainId); }}
          className="text-[11px] text-th-muted hover:text-th-primary font-display">Auto order</button>
      </div>
      <div className="space-y-1">
        {order.map((id, i) => {
          const p = byId.get(id);
          if (!p) return null;
          return (
            <div key={id} className="flex items-center gap-2 text-xs rounded-lg bg-th-raised px-2 py-1.5">
              <span className="w-5 text-th-faint font-mono">{i + 1}</span>
              <span className={`w-6 font-mono ${ovrColorClass(p.overall)}`}>{p.overall}</span>
              <span className="flex-1 truncate font-display text-th-primary">
                {p.name}
                {p.isWicketKeeper && <span className="text-cyan-400/80 text-[9px] ml-1">WK</span>}
                {p.isInternational && <span className="text-orange-400/80 text-[9px] ml-1">OS</span>}
              </span>
              <span className="text-[10px] text-th-faint w-20 truncate">{roleLabel(p.role)}</span>
              <label className="flex items-center gap-1 text-[10px] text-th-muted cursor-pointer">
                <input type="radio" name="captain" checked={captainId === id} onChange={() => setCaptainId(id)} className="accent-orange-500" />
                C
              </label>
              <button onClick={() => move(i, -1)} className="text-th-faint hover:text-th-primary px-1">↑</button>
              <button onClick={() => move(i, 1)} className="text-th-faint hover:text-th-primary px-1">↓</button>
            </div>
          );
        })}
      </div>
      {problems.length > 0 && <p className="text-amber-400 text-xs font-display mt-2">{problems.join(" · ")}</p>}
      <button onClick={() => onConfirm({ battingOrder: order, captainId })} disabled={disabled} data-testid="lineup-confirm"
        className="mt-4 w-full px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-40 text-white text-sm font-display font-semibold rounded-xl">
        {confirmLabel}
      </button>
    </div>
  );
}

// ── Match viewer (wraps the existing live-match page) ──────────────────

export function DraftMatchViewer({ start, userSeatId, onDone, onSkip }: {
  start: DraftMatchStart;
  /** The side the viewer controls in-match (single player), or null to just watch (multiplayer) */
  userSeatId: string | null;
  onDone: (state: MatchState) => void;
  onSkip?: () => void;
}) {
  const { teams, matchState } = useMemo(() => {
    const [home, away] = teamsFromMatchStart(start, userSeatId);
    return { teams: [home, away], matchState: createMatchState(home, away, draftMatchRules(start.maxOverseasInXI), userSeatId, start.seed) };
  }, [start, userSeatId]);
  const [completed, setCompleted] = useState<MatchState | null>(null);
  const finished = completed !== null;

  return (
    <div>
      <div className="max-w-6xl mx-auto px-4 pt-4">
        <span className="text-xs font-display text-th-muted">Draft Match · Game {start.gameNo}</span>
      </div>
      {(finished || onSkip) && (
        // Fixed so it stays reachable while the live-match page scrolls
        <button onClick={() => (completed ? onDone(completed) : onSkip?.())} data-testid="draft-match-continue"
          className="fixed bottom-5 right-5 z-[60] px-5 py-3 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-display font-semibold shadow-lg shadow-orange-500/30">
          {finished ? "See result & rematch" : "Skip to result"}
        </button>
      )}
      <LiveMatchPage
        seasonNumber={DRAFT_MATCH_SEASON_KEY}
        matchState={matchState}
        matchIndex={start.gameNo}
        userTeamId={userSeatId}
        teams={teams}
        previousResults={[]}
        onMatchComplete={(done) => setCompleted(done)}
      />
    </div>
  );
}

// ── Result card ─────────────────────────────────────────────────────────

export function MatchResultCard({ summary, sides, shareText, series, seatNames }: {
  summary: DraftMatchResultSummary;
  sides: { id: string; name: string; xi: string[]; captain?: string }[];
  shareText: string;
  series?: DraftSeries;
  seatNames?: Record<string, string>;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(shareText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  };
  return (
    <div className="rounded-2xl border border-th bg-th-surface p-5" data-testid="draft-match-result">
      <div className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted">{summary.venue}</div>
      <h3 className="text-xl font-display font-bold text-gradient-orange mt-1">{summary.result}</h3>
      {series && (
        <p className="text-xs text-th-muted font-display mt-1">
          Best of {series.bestOf}: {Object.entries(series.wins).map(([id, w]) => `${seatNames?.[id] ?? id} ${w}`).join(" – ")}
          {series.winnerSeatId ? ` · ${seatNames?.[series.winnerSeatId] ?? series.winnerSeatId} wins the series` : ""}
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        {[summary.innings1, summary.innings2].map((inn, i) => (
          <div key={i} className="rounded-xl bg-th-raised p-3">
            <div className="flex justify-between text-sm font-display font-semibold text-th-primary mb-2">
              <span>{inn.battingTeamName}</span>
              <span className="font-mono">{inn.totalRuns}/{inn.totalWickets} <span className="text-th-muted text-xs">({inn.totalOvers})</span></span>
            </div>
            {inn.batters.filter(b => b.balls > 0 || b.howOut !== "not out").slice(0, 11).map(b => (
              <div key={b.playerId} className="flex text-[11px] text-th-secondary">
                <span className="flex-1 truncate">{b.playerName}</span>
                <span className="text-th-faint truncate max-w-[110px] mr-2">{b.howOut}</span>
                <span className="font-mono w-14 text-right">{b.runs}{b.howOut === "not out" ? "*" : ""} ({b.balls})</span>
              </div>
            ))}
            <div className="border-t border-th mt-2 pt-2">
              {inn.bowlers.map(b => (
                <div key={b.playerId} className="flex text-[11px] text-th-muted">
                  <span className="flex-1 truncate">{b.playerName}</span>
                  <span className="font-mono">{b.overs}-{b.runs}-{b.wickets}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-th-secondary font-display mt-3">Player of the match: <span className="text-th-primary font-semibold">{summary.manOfTheMatch.playerName}</span></p>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        {sides.map(s => (
          <div key={s.id} className="text-[11px] text-th-muted">
            <span className="text-th-secondary font-display font-semibold">{s.name}: </span>
            {s.xi.map(n => (n === s.captain ? `${n} (c)` : n)).join(", ")}
          </div>
        ))}
      </div>
      <button onClick={copy} className="mt-4 px-4 py-2 rounded-xl border border-th bg-th-raised text-xs font-display font-semibold text-th-secondary hover:bg-th-hover">
        {copied ? "Copied" : "Copy result to share"}
      </button>
    </div>
  );
}
