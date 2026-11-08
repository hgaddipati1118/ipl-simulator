/**
 * The International series page's Test screens (InternationalPage, the Test format of international.ts):
 * - a live Test: LiveTestPage on the match's IndexedDB save (test-series.ts testStoreKey), so it resumes after leaving or a
 *   reload; the series records the result the moment the match ends;
 * - a finished Test's scorecard: TestScorecard on the saved final state, or the series record's own innings cards (the
 *   `fallback`) when the state is gone (cleared site data, another browser).
 */

import { useEffect, useState, type ReactNode } from "react";
import type { TestMatchState } from "@ipl-sim/engine";
import { LiveTestPage } from "../pages/LiveTestPage";
import { TestScorecard } from "./TestScorecard";
import { loadLiveTest } from "./test-db";

/** The saved state under `storeKey` (undefined while loading, null when there is none), or `initial` when given */
function useSavedTest(storeKey: string, initial: TestMatchState | null = null): TestMatchState | null | undefined {
  const [st, setSt] = useState<TestMatchState | null | undefined>(initial ?? undefined);
  useEffect(() => {
    if (initial) { setSt(initial); return; }
    let alive = true;
    setSt(undefined);
    void loadLiveTest(storeKey).then(s => { if (alive) setSt(s); });
    return () => { alive = false; };
  }, [storeKey, initial]);
  return st;
}

function Loading({ text }: { text: string }) {
  return <div className="max-w-md mx-auto px-4 py-20 text-center text-th-muted font-display animate-pulse">{text}</div>;
}

export function SeriesLiveTest({ storeKey, initial, title, colors, onMatchEnd, onContinue, onBack }: {
  storeKey: string;
  /** A match just started (else the save is loaded) */
  initial: TestMatchState | null;
  title: string;
  colors: Record<string, string>;
  onMatchEnd: (st: TestMatchState) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const st = useSavedTest(storeKey, initial);
  if (st === undefined) return <Loading text="Loading the match..." />;
  if (st === null) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center" data-testid="series-test-missing">
        <p className="text-sm text-th-secondary font-display mb-4">
          This Test's save was not found on this device. Abandon it on the series page to play the match again.
        </p>
        <button onClick={onBack} className="px-5 py-2.5 bg-th-hover text-th-primary font-display font-semibold rounded-xl border border-th text-sm hover:bg-th-body">
          Back to the series
        </button>
      </div>
    );
  }
  return <LiveTestPage state={st} saveKey={storeKey} colors={colors} title={title} onMatchEnd={onMatchEnd} onComplete={onContinue} />;
}

export function SeriesTestScorecard({ storeKey, title, colors, onBack, fallback }: {
  storeKey: string;
  /** "1st Test · Lord's" */
  title: string;
  colors: Record<string, string>;
  onBack: () => void;
  /** Shown when the saved state is gone: the series record's own scorecard */
  fallback: ReactNode;
}) {
  const st = useSavedTest(storeKey);
  if (st === undefined) return <Loading text="Loading the scorecard..." />;
  if (!st || st.status !== "completed") return <>{fallback}</>;
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in" data-testid="series-scorecard">
      <button onClick={onBack} className="text-th-secondary hover:text-th-primary text-sm mb-4">&larr; Back to the series</button>
      <div className="text-[10px] uppercase tracking-wider font-display text-th-muted mb-2">{title}</div>
      <TestScorecard st={st} colors={colors} />
    </div>
  );
}
