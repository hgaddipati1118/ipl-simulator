/**
 * The user's captaincy between deliveries: batting approach, declaring, the next batter in (and asking at every wicket),
 * bowling changes with each bowler's figures, spell and workload, the new ball once due, and handing everything to the CPU
 * captain. Whatever the user leaves alone the CPU captain decides with the fitted policies.
 */

import { useState } from "react";
import {
  changeTestBowlerTo, currentTestInnings, declareTest, setTestAutoCaptain, setTestBattingApproach, setTestNextBatter,
  takeTestNewBall, testBatterQueue, testBowlingOptions, type TestApproach, type TestMatchState,
} from "@ipl-sim/engine";
import { canDeclare, playerName, userBatting, userFielding } from "./test-view";

type Act = <T>(fn: (st: TestMatchState) => T) => T;

const APPROACHES: { value: TestApproach | null; label: string; hint: string }[] = [
  { value: null, label: "Captain", hint: "The fitted policy: pushes before a declaration, chases to the situation" },
  { value: "defend", label: "Defend", hint: "Block for time: fewer runs, fewer wickets" },
  { value: "normal", label: "Normal", hint: "Bat to the conditions" },
  { value: "attack", label: "Attack", hint: "Push the scoring: more runs, more risk" },
];

export function TestCaptainPanel({ st, act }: { st: TestMatchState; act: Act }) {
  const inn = currentTestInnings(st);
  const [keepOn, setKeepOn] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDeclare, setConfirmDeclare] = useState(false);
  if (!inn || !st.userTeamId || st.status === "completed") return null;
  const team = st.teams[st.userTeamId];
  const batting = userBatting(st);
  const fielding = userFielding(st);
  const queue = testBatterQueue(inn);
  // the attack first (those who have bowled most at the top), part-timers after
  const bowlers = fielding
    ? testBowlingOptions(st).sort((a, b) => Number(b.frontLine) - Number(a.frontLine) || parseFloat(b.overs) - parseFloat(a.overs))
    : [];
  const nextUp = inn.nextBowler?.[inn.overBalls === 0 ? inn.end : inn.end === 0 ? 1 : 0];

  return (
    <div className="rounded-2xl border border-th bg-th-surface p-4 space-y-4" data-testid="test-captain">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-widest font-display font-bold text-th-muted">
          Captain: {team.name} {batting ? "batting" : fielding ? "in the field" : ""}
        </div>
        <label className="flex items-center gap-2 text-xs text-th-secondary font-display cursor-pointer">
          <input type="checkbox" checked={st.autoUser} onChange={e => act(s => setTestAutoCaptain(s, e.target.checked))} data-testid="test-auto-captain" />
          CPU captains my side too
        </label>
      </div>

      {batting && (
        <div className="space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-th-muted font-display mb-1.5">Approach</div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup">
              {APPROACHES.map(a => {
                const on = team.approach === a.value;
                return (
                  <button key={a.label} title={a.hint} onClick={() => act(s => setTestBattingApproach(s, a.value))} data-testid={`test-approach-${a.label.toLowerCase()}`}
                    className={`px-3 py-1.5 rounded-lg text-xs font-display font-semibold border transition-colors ${on ? "border-orange-500 bg-orange-500/15 text-orange-300" : "border-th bg-th-body text-th-secondary hover:bg-th-hover"}`}>
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-th-muted font-display mb-1.5">Next batter in</div>
              <select value={inn.nextChoice ?? ""} onChange={e => act(s => setTestNextBatter(s, e.target.value || null))} data-testid="test-next-batter"
                className="bg-th-body border border-th rounded-lg px-2 py-1.5 text-xs text-th-primary font-display">
                <option value="">In order{queue[0] ? ` (${playerName(st, queue[0])})` : ""}</option>
                {queue.map(id => <option key={id} value={id}>{playerName(st, id)}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-th-secondary font-display cursor-pointer pb-1.5">
              <input type="checkbox" checked={!!st.pickBatters} onChange={e => act(s => { s.pickBatters = e.target.checked; })} />
              Ask me at every wicket
            </label>
            {canDeclare(st) && !confirmDeclare && (
              <button onClick={() => setConfirmDeclare(true)} data-testid="test-declare"
                className="ml-auto px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white font-display font-semibold rounded-xl text-xs">
                Declare
              </button>
            )}
            {canDeclare(st) && confirmDeclare && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-th-secondary font-display">Declare at {inn.runs}/{inn.wickets}?</span>
                <button onClick={() => { setConfirmDeclare(false); act(s => declareTest(s)); }} data-testid="test-declare-confirm"
                  className="px-3 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-display font-semibold rounded-lg text-xs">Yes, declare</button>
                <button onClick={() => setConfirmDeclare(false)} className="px-3 py-1.5 bg-th-hover text-th-secondary border border-th rounded-lg text-xs font-display">No</button>
              </div>
            )}
          </div>
        </div>
      )}

      {fielding && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-wider text-th-muted font-display">
              Bowling change{nextUp ? ` · next: ${playerName(st, nextUp)}` : ""}
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-th-secondary font-display cursor-pointer">
                <input type="checkbox" checked={keepOn} onChange={e => setKeepOn(e.target.checked)} /> Keep him on
              </label>
              {inn.newBallDue && (
                <button onClick={() => act(s => takeTestNewBall(s))} data-testid="test-take-new-ball"
                  className="px-3 py-1.5 rounded-lg text-xs font-display font-semibold border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
                  Take the new ball
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" data-testid="test-bowlers">
            {bowlers.map(b => (
              <button key={b.playerId} disabled={b.blocked}
                onClick={() => {
                  try { act(s => changeTestBowlerTo(s, b.playerId, { keepOn })); setMsg(`${b.name} bowls the next over from that end.`); }
                  catch (e) { setMsg((e as Error).message); }
                }}
                className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors ${b.playerId === nextUp ? "border-orange-500 bg-orange-500/10" : "border-th bg-th-body hover:bg-th-hover"} disabled:opacity-40 disabled:cursor-not-allowed`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display font-semibold text-th-primary">{b.name}{!b.frontLine && <span className="text-th-faint font-normal"> (part-time)</span>}</span>
                  <span className="font-mono text-th-muted">{b.overs}-{b.maidens}-{b.runs}-{b.wickets}</span>
                </div>
                <div className="flex gap-3 text-[10px] text-th-faint font-display mt-0.5">
                  <span>{b.spin ? "spin" : "pace"}</span>
                  <span>spell {b.spellOvers}</span>
                  <span>{b.oversToday} today</span>
                  {b.rested < 99 && <span>rested {b.rested}</span>}
                  {b.tiring && <span className="text-amber-400">tiring</span>}
                  {b.blocked && <span>bowled the last over</span>}
                </div>
              </button>
            ))}
          </div>
          {msg && <div className="text-[11px] text-th-muted font-display">{msg}</div>}
        </div>
      )}
    </div>
  );
}
