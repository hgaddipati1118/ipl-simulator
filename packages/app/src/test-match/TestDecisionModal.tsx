/**
 * A decision the match waits on: the toss call, enforcing the follow-on, the new ball, a DRS review (batting or fielding), the
 * next batter or a nightwatchman. The wording comes from test-view.ts decisionView.
 */

import type { TestMatchState, TestPendingDecision } from "@ipl-sim/engine";
import { decisionView } from "./test-view";

export function TestDecisionModal({ st, pending, onChoose, onLetCpu }: {
  st: TestMatchState;
  pending: TestPendingDecision;
  onChoose: (value: string) => void;
  onLetCpu: () => void;
}) {
  const v = decisionView(st, pending);
  const many = v.options.length > 3;
  return (
    <div className="fixed inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-lg z-40 flex items-center justify-center animate-fade-in" data-testid="test-decision">
      <div className="bg-white dark:bg-th-surface rounded-2xl border border-th p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="text-xs text-th-muted uppercase tracking-widest font-display mb-2">{pending.type.replace("_", " ")}</div>
        <div className="text-xl font-display font-extrabold text-th-primary mb-1">{v.title}</div>
        <div className="text-sm text-th-secondary mb-5">{v.subtitle}</div>
        <div className={many ? "space-y-1.5 max-h-[45vh] overflow-y-auto" : "flex flex-col sm:flex-row gap-3"}>
          {v.options.map(o => (
            <button key={o.value} onClick={() => onChoose(o.value)} data-testid={`test-choice-${o.value}`}
              className={many
                ? `w-full text-left px-3 py-2.5 rounded-lg border transition-all ${o.primary ? "border-orange-500 bg-orange-500/10" : "border-th bg-th-body hover:bg-th-hover"}`
                : `flex-1 px-4 py-3 rounded-xl font-display font-semibold text-sm transition-all ${o.primary
                  ? "bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white"
                  : "bg-th-hover text-th-primary border border-th hover:bg-th-body"}`}>
              <div className={many ? "font-display font-semibold text-th-primary text-sm" : ""}>{o.label}</div>
              {o.hint && <div className={`text-[11px] ${many ? "text-th-faint" : o.primary ? "text-white/80" : "text-th-muted"} font-normal mt-0.5`}>{o.hint}</div>}
            </button>
          ))}
        </div>
        <button onClick={onLetCpu} className="mt-4 w-full text-xs text-th-muted font-display hover:text-th-secondary" data-testid="test-choice-cpu">
          Let the captain decide
        </button>
      </div>
    </div>
  );
}
