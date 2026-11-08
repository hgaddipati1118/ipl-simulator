/**
 * Live Test match (docs/FORMATS.md, Test section 7): ball by ball, or skip ahead by over, session, day, innings or to the end;
 * the user's decisions (toss, follow-on, new ball, DRS, next batter / nightwatchman) pause the match, and between deliveries he
 * captains (approach, declaring, bowling changes, the new ball). Commentary and the scorecard as tabs; the state saves to
 * IndexedDB with `saveKey` and resumes exactly.
 *
 * Takes a live state from test-match/test-entry.ts startTestLive (or a resumed save), so any page (the International series
 * page, the dev route) can play a Test here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceTest, autoResolveTestDecision, decideTest, finishLiveTest,
  type TestAdvanceUntil, type TestMatchResult, type TestMatchState,
} from "@ipl-sim/engine";
import { ensureCommentaryModel } from "../commentary-loader";
import { useLiveTest } from "../test-match/useLiveTest";
import { TestScoreboard } from "../test-match/TestScoreboard";
import { TestCommentary } from "../test-match/TestCommentary";
import { TestCaptainPanel } from "../test-match/TestCaptainPanel";
import { TestDecisionModal } from "../test-match/TestDecisionModal";
import { TestScorecard } from "../test-match/TestScorecard";
import { teamScoreLine } from "../test-match/test-view";

export interface LiveTestPageProps {
  /** The live match (from startTestLive or a resumed save). Mutated in place as it is played. */
  state: TestMatchState;
  /** Save the match to IndexedDB under this key after every action */
  saveKey?: string;
  /** Primary colour by team id */
  colors?: Record<string, string>;
  /** Heading, e.g. "1st Test" */
  title?: string;
  /** The match has just ended (once; also when a finished match is opened): record the result here */
  onMatchEnd?: (st: TestMatchState) => void;
  /** The match is over and the user moves on */
  onComplete?: (result: TestMatchResult) => void;
  /** A "Leave" button (the save is written first) */
  onExit?: () => void;
}

const SKIPS: { until: TestAdvanceUntil; label: string }[] = [
  { until: "ball", label: "Ball" }, { until: "over", label: "Over" }, { until: "session", label: "Session" },
  { until: "day", label: "Day" }, { until: "innings", label: "Innings" }, { until: "match", label: "Match" },
];
const SPEEDS = { "1x": 900, "3x": 300, "10x": 90 } as const;

export function LiveTestPage({ state, saveKey, colors = {}, title = "Test match", onMatchEnd, onComplete, onExit }: LiveTestPageProps) {
  const { st, act, flush } = useLiveTest(state, saveKey);
  const [tab, setTab] = useState<"commentary" | "scorecard">("commentary");
  const [autoDecide, setAutoDecide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<keyof typeof SPEEDS | null>(null);
  const [hideResult, setHideResult] = useState(false);

  useEffect(() => { void ensureCommentaryModel(); }, []);

  const advance = useCallback((until: TestAdvanceUntil) => {
    if (until === "ball" || until === "over") { act(s => advanceTest(s, until, { autoDecide })); return; }
    // longer skips: let the button show it is working first
    setBusy(true);
    setTimeout(() => { act(s => advanceTest(s, until, { autoDecide })); setBusy(false); }, 20);
  }, [act, autoDecide]);

  // ball-by-ball autoplay, stopped by a decision or the end
  useEffect(() => {
    if (!playing) return;
    if (st.status !== "in_progress") { setPlaying(null); return; }
    const t = setTimeout(() => act(s => advanceTest(s, "ball")), SPEEDS[playing]);
    return () => clearTimeout(t);
  });

  const pending = st.status === "waiting_for_decision" ? st.pending : undefined;
  const done = st.status === "completed";

  const ended = useRef(false);
  useEffect(() => {
    if (done && !ended.current) { ended.current = true; onMatchEnd?.(st); }
  });
  const home = st.teams[st.teamOrder[0]];
  const away = st.teams[st.teamOrder[1]];

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-6" data-testid="live-test-page">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-th-muted font-display">{title} · {st.days} days{st.gender === "female" ? " · women" : ""}</div>
          <h1 className="text-xl sm:text-2xl font-display font-extrabold text-th-primary">
            <span style={{ color: colors[home.id] }}>{home.name}</span> <span className="text-th-faint">v</span> <span style={{ color: colors[away.id] }}>{away.name}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {saveKey && <span className="text-[11px] text-th-faint font-display">Saved automatically</span>}
          {onExit && (
            <button onClick={() => { void flush().then(onExit); }} className="px-3 py-1.5 bg-th-hover text-th-secondary font-display font-semibold rounded-lg border border-th text-xs hover:bg-th-body">
              Leave
            </button>
          )}
        </div>
      </div>

      <TestScoreboard st={st} colors={colors} />

      {/* Controls */}
      <div className="mt-3 rounded-2xl border border-th bg-th-surface p-3 flex flex-wrap items-center gap-2" data-testid="test-controls">
        {SKIPS.map(s => (
          <button key={s.until} disabled={done || busy || !!pending || !!playing} onClick={() => advance(s.until)} data-testid={`test-skip-${s.until}`}
            className={`px-3 py-2 rounded-xl font-display font-semibold text-xs transition-all disabled:opacity-40 disabled:cursor-not-allowed ${s.until === "ball"
              ? "bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white"
              : "bg-th-hover text-th-primary border border-th hover:bg-th-body"}`}>
            {s.until === "ball" ? "Next ball" : s.until === "match" ? "To the end" : `Skip ${s.label.toLowerCase()}`}
          </button>
        ))}
        <div className="flex items-center gap-1 ml-auto">
          {(Object.keys(SPEEDS) as (keyof typeof SPEEDS)[]).map(sp => (
            <button key={sp} disabled={done || !!pending} onClick={() => setPlaying(p => (p === sp ? null : sp))}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-bold border disabled:opacity-40 ${playing === sp ? "border-orange-500 bg-orange-500/15 text-orange-300" : "border-th text-th-muted hover:bg-th-hover"}`}>
              {playing === sp ? "❚❚" : "▶"} {sp}
            </button>
          ))}
        </div>
        <label className="w-full flex items-center gap-2 text-[11px] text-th-muted font-display cursor-pointer">
          <input type="checkbox" checked={autoDecide} onChange={e => setAutoDecide(e.target.checked)} data-testid="test-auto-decide" />
          When skipping, let the captain answer my decisions (toss, reviews, follow-on, new ball, nightwatchman)
        </label>
        {busy && <div className="text-[11px] text-amber-400 font-display">Playing on…</div>}
      </div>

      <div className="mt-3">
        <TestCaptainPanel st={st} act={act} />
      </div>

      {/* Tabs */}
      <div className="mt-4 flex gap-1.5">
        {(["commentary", "scorecard"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} data-testid={`test-tab-${t}`}
            className={`px-4 py-2 rounded-xl text-xs font-display font-semibold border ${tab === t ? "border-orange-500 bg-orange-500/10 text-orange-300" : "border-th bg-th-body text-th-secondary hover:bg-th-hover"}`}>
            {t === "commentary" ? "Commentary" : "Scorecard"}
          </button>
        ))}
      </div>
      <div className="mt-3 rounded-2xl border border-th bg-th-surface p-3 sm:p-4">
        {tab === "commentary" ? <TestCommentary st={st} /> : <TestScorecard st={st} colors={colors} />}
      </div>

      {pending && (
        <TestDecisionModal st={st} pending={pending}
          onChoose={v => act(s => decideTest(s, v))}
          onLetCpu={() => act(s => autoResolveTestDecision(s))} />
      )}

      {done && !hideResult && st.result && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-lg z-40 flex items-center justify-center animate-fade-in" data-testid="test-complete">
          <div className="bg-white dark:bg-th-surface rounded-2xl border border-th p-6 sm:p-8 max-w-md w-full mx-4 text-center shadow-2xl">
            <div className="text-xs text-th-muted uppercase tracking-widest font-display mb-3">Match complete · day {st.result.day}</div>
            {st.teamOrder.map(id => (
              <div key={id} className="flex justify-between font-display text-sm mb-1">
                <span className="font-semibold" style={{ color: colors[id] }}>{st.teams[id].name}</span>
                <span className="font-mono text-th-primary">{teamScoreLine(st, id)}</span>
              </div>
            ))}
            <div className="rounded-xl bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 px-4 py-3 my-4">
              <div className="text-lg font-display font-extrabold text-th-primary">{st.result.text}</div>
            </div>
            {st.result.playerOfMatch.playerId && (
              <div className="text-xs text-th-muted mb-5">
                Player of the match: <span className="text-th-primary font-semibold">{st.result.playerOfMatch.playerName}</span> ({st.result.playerOfMatch.reason})
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button onClick={() => { setTab("scorecard"); setHideResult(true); }} data-testid="test-view-scorecard"
                className="px-5 py-2.5 bg-th-hover text-th-primary font-display font-semibold rounded-xl border border-th text-sm hover:bg-th-body">
                View scorecard
              </button>
              {onComplete && (
                <button onClick={() => onComplete(finishLiveTest(st))} data-testid="test-continue"
                  className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-semibold rounded-xl text-sm">
                  Continue
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LiveTestPage;
