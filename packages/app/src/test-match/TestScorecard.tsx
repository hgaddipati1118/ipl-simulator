/**
 * The Test scorecard: the match summary (toss, result including draws and ties, player of the match, days, the innings line by
 * line), then each innings with its batting (how out, runs, balls, fours, sixes, strike rate), extras and total, fall of
 * wickets, and bowling figures; then the match's events (declarations, the follow-on, new balls, weather). Works for a
 * finished match and one in progress.
 */

import { useState } from "react";
import { testInningsScorecard, type TestMatchState } from "@ipl-sim/engine";
import { inningsScore, oversText, teamScoreLine } from "./test-view";

export function TestScorecard({ st, colors = {} }: { st: TestMatchState; colors?: Record<string, string> }) {
  const [open, setOpen] = useState<number>(Math.max(0, st.innings.length - 1));
  const r = st.result;
  return (
    <div className="space-y-4" data-testid="test-scorecard">
      <div className="rounded-2xl border border-th bg-th-surface p-4">
        <div className="text-[11px] uppercase tracking-widest font-display font-bold text-th-muted mb-2">Match summary</div>
        {r ? (
          <div className="text-lg font-display font-extrabold text-th-primary" data-testid="test-result">{r.text}</div>
        ) : (
          <div className="text-sm font-display text-th-secondary">In progress: day {st.day} of {st.days}</div>
        )}
        <div className="mt-2 grid gap-1 text-sm">
          {st.teamOrder.map(id => (
            <div key={id} className="flex justify-between font-display">
              <span className="font-semibold" style={{ color: colors[id] }}>{st.teams[id].name}</span>
              <span className="font-mono text-th-primary">{teamScoreLine(st, id)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 text-xs text-th-muted space-y-0.5">
          {st.toss && <div>{st.teams[st.toss.winnerId].name} won the toss and chose to {st.toss.decision}.</div>}
          <div>{st.venueName}{r ? ` · ended on day ${r.day} of ${st.days}` : ""}</div>
          {r?.playerOfMatch.playerId && <div>Player of the match: <span className="text-th-secondary font-semibold">{r.playerOfMatch.playerName}</span> ({r.playerOfMatch.reason})</div>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {st.innings.map((inn, i) => (
          <button key={i} onClick={() => setOpen(i)} data-testid={`test-scorecard-tab-${i + 1}`}
            className={`px-3 py-1.5 rounded-lg text-xs font-display font-semibold border ${open === i ? "border-orange-500 bg-orange-500/10 text-orange-300" : "border-th bg-th-body text-th-secondary hover:bg-th-hover"}`}>
            {st.teams[inn.battingTeamId].shortName} {inningsScore(inn)}{inn.followOn ? " f/o" : ""}
          </button>
        ))}
      </div>

      {st.innings[open] && (() => {
        const inn = st.innings[open];
        const sc = testInningsScorecard(st, inn);
        const dnb = st.teams[inn.battingTeamId].xi.filter(id => !inn.batters[id]).map(id => st.players[id]?.name ?? id);
        return (
          <div className="rounded-2xl border border-th bg-th-surface overflow-hidden" data-testid="test-innings-card">
            <div className="px-4 py-2.5 border-b border-th flex justify-between items-baseline">
              <span className="font-display font-bold" style={{ color: colors[inn.battingTeamId] }}>
                {sc.battingTeamName} · innings {inn.number}{inn.followOn ? " (following on)" : ""}
              </span>
              <span className="font-mono text-th-primary">{inningsScore(inn)} ({oversText(inn.legalBalls)} ov)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-th-muted font-display uppercase tracking-wider text-[10px]">
                    <th className="text-left px-4 py-2">Batter</th><th className="text-left px-2 py-2">How out</th>
                    <th className="text-right px-2">R</th><th className="text-right px-2">B</th><th className="text-right px-2">4s</th>
                    <th className="text-right px-2">6s</th><th className="text-right px-4">SR</th>
                  </tr>
                </thead>
                <tbody>
                  {sc.batters.map(b => (
                    <tr key={b.playerId} className="border-t border-th/40">
                      <td className="px-4 py-1.5 font-display font-semibold text-th-primary">{b.playerName}</td>
                      <td className="px-2 text-th-muted">{b.howOut}</td>
                      <td className="text-right px-2 font-mono font-bold text-th-primary">{b.runs}</td>
                      <td className="text-right px-2 font-mono text-th-secondary">{b.balls}</td>
                      <td className="text-right px-2 font-mono text-th-secondary">{b.fours}</td>
                      <td className="text-right px-2 font-mono text-th-secondary">{b.sixes}</td>
                      <td className="text-right px-4 font-mono text-th-muted">{b.strikeRate.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 border-t border-th/40 text-xs text-th-secondary flex justify-between">
              <span>Extras (b {sc.extras.byes ?? 0}, lb {sc.extras.legByes}, w {sc.extras.wides}, nb {sc.extras.noBalls})</span>
              <span className="font-mono">{sc.extras.total}</span>
            </div>
            <div className="px-4 py-2 border-t border-th/40 text-xs font-display font-bold text-th-primary flex justify-between">
              <span>Total{inn.closed === "declared" ? " (declared)" : ""}</span>
              <span className="font-mono">{inn.runs}/{inn.wickets} ({oversText(inn.legalBalls)} ov)</span>
            </div>
            {dnb.length > 0 && <div className="px-4 py-2 border-t border-th/40 text-[11px] text-th-muted">Did not bat: {dnb.join(", ")}</div>}
            {sc.fallOfWickets.length > 0 && (
              <div className="px-4 py-2 border-t border-th/40 text-[11px] text-th-muted" data-testid="test-fow">
                <span className="font-display font-semibold text-th-secondary">Fall of wickets:</span> {sc.fallOfWickets.join(", ")}
              </div>
            )}
            <div className="overflow-x-auto border-t border-th">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-th-muted font-display uppercase tracking-wider text-[10px]">
                    <th className="text-left px-4 py-2">Bowler</th><th className="text-right px-2">O</th><th className="text-right px-2">M</th>
                    <th className="text-right px-2">R</th><th className="text-right px-2">W</th><th className="text-right px-2">Econ</th>
                    <th className="text-right px-2">Wd</th><th className="text-right px-4">Nb</th>
                  </tr>
                </thead>
                <tbody>
                  {sc.bowlers.map(b => (
                    <tr key={b.playerId} className="border-t border-th/40">
                      <td className="px-4 py-1.5 font-display font-semibold text-th-primary">{b.playerName}</td>
                      <td className="text-right px-2 font-mono text-th-secondary">{b.overs}</td>
                      <td className="text-right px-2 font-mono text-th-secondary">{b.maidens}</td>
                      <td className="text-right px-2 font-mono text-th-secondary">{b.runs}</td>
                      <td className="text-right px-2 font-mono font-bold text-th-primary">{b.wickets}</td>
                      <td className="text-right px-2 font-mono text-th-muted">{b.economy.toFixed(2)}</td>
                      <td className="text-right px-2 font-mono text-th-muted">{b.wides}</td>
                      <td className="text-right px-4 font-mono text-th-muted">{b.noBalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {st.events.some(e => e.kind === "declaration" || e.kind === "follow_on" || e.kind === "weather" || e.kind === "new_ball" || e.kind === "nightwatchman") && (
        <div className="rounded-2xl border border-th bg-th-surface p-4">
          <div className="text-[11px] uppercase tracking-widest font-display font-bold text-th-muted mb-2">Match notes</div>
          <ul className="text-xs text-th-secondary space-y-1">
            {st.events.filter(e => e.kind === "declaration" || e.kind === "follow_on" || e.kind === "weather" || e.kind === "new_ball" || e.kind === "nightwatchman")
              .map((e, i) => <li key={i}>{/^Day \d/.test(e.text) ? e.text : `Day ${e.day}: ${e.text}`}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
