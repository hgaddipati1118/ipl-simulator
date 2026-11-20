/**
 * A side's bowling plan (T20I, ODI): which bowlers bowl the powerplay, the middle overs and the death, and individual overs fixed
 * to a bowler. Left alone, the side bowls as real captains do (the captain's fitted choice, engine bowling-choice.ts): the strip
 * under the heading shows that default over by over. The editor only ever holds what the user changed (`undefined` = the default).
 * The caps (4 overs a bowler in a T20I, 10 in an ODI) and the no-two-in-a-row rule still apply in the match; a plan that breaks
 * them is flagged here and the match plays the nearest legal choice.
 */
import { useMemo } from "react";
import { bowlerKind, modelPlanFor, rankByBowling, type BowlingPlan, type Player } from "@ipl-sim/engine";

type PlanFormat = "t20" | "odi" | "test";

const PHASES: { key: "powerplay" | "middle" | "death"; label: string; overs: Record<"t20" | "odi", string> }[] = [
  { key: "powerplay", label: "Powerplay", overs: { t20: "overs 1-6", odi: "overs 1-10" } },
  { key: "middle", label: "Middle overs", overs: { t20: "overs 7-15", odi: "overs 11-40" } },
  { key: "death", label: "Death", overs: { t20: "overs 16-20", odi: "overs 41-50" } },
];

const KIND_LABEL = { fast: "fast", medium: "medium", spin: "spin", slow: "part-time" } as const;
const surname = (name: string) => name.split(" ").slice(-1)[0];

/** Spin comes on from over N of an innings (Test); undefined = the captain's fitted share of spin overs */
const SPIN_FROM = [0, 10, 15, 20, 25, 30, 40];

/**
 * A Test side's plan: who opens (the first over from each end) and when spin comes on. Everything else is the captain's fitted
 * choice (spells, workloads by day, the new ball at 80 overs: engine test-match.ts chooseBowler).
 */
function TestPlanEditor({ bowlers, value, onChange }: { bowlers: Player[]; value: BowlingPlan | undefined; onChange: (p: BowlingPlan | undefined) => void }) {
  const plan: BowlingPlan = value ?? { powerplay: [], middle: [], death: [] };
  const set = (next: BowlingPlan) => onChange(Object.keys(next.overs ?? {}).length === 0 && next.spinFrom === undefined ? undefined : next);
  const opener = (o: 0 | 1, id: string) => {
    const overs = { ...(plan.overs ?? {}) };
    if (id) overs[o] = id; else delete overs[o];
    set({ ...plan, overs: Object.keys(overs).length ? overs : undefined });
  };
  const sel = "rounded bg-th-raised text-th-secondary text-[11px] font-display px-2 py-1 border border-th";
  return (
    <div className="rounded-2xl border border-th bg-th-surface p-5" data-testid="bowling-plan">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-display font-semibold text-th-primary">Bowling plan</h3>
        <button type="button" onClick={() => onChange(undefined)} disabled={!value} data-testid="bowling-plan-reset"
          className="text-[11px] text-th-muted hover:text-th-primary font-display disabled:opacity-40">Back to the default</button>
      </div>
      <p className="text-[11px] text-th-faint font-display mb-3">Left alone, the captain bowls as real Test captains do: spells, the best bowlers most, spin by the day and the ground, the new ball at 80 overs.</p>
      <div className="grid sm:grid-cols-3 gap-3">
        {([0, 1] as const).map(o => (
          <label key={o} className="text-[10px] uppercase tracking-wider font-display text-th-muted">{o === 0 ? "Opens from the first end" : "Opens from the other end"}
            <select value={plan.overs?.[o] ?? ""} onChange={e => opener(o, e.target.value)} data-testid={`plan-opener-${o}`} className={`${sel} block mt-1 w-full normal-case`}>
              <option value="">Captain's choice</option>
              {bowlers.map(p => <option key={p.id} value={p.id}>{surname(p.name)} ({KIND_LABEL[bowlerKind(p.bowlingStyle)]})</option>)}
            </select>
          </label>
        ))}
        <label className="text-[10px] uppercase tracking-wider font-display text-th-muted">Spin comes on
          <select value={plan.spinFrom ?? ""} onChange={e => set({ ...plan, spinFrom: e.target.value === "" ? undefined : Number(e.target.value) })} data-testid="plan-spin-from" className={`${sel} block mt-1 w-full normal-case`}>
            <option value="">When the captain wants it</option>
            {SPIN_FROM.map(n => <option key={n} value={n}>{n === 0 ? "From the first over" : `Not before over ${n + 1}`}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function LimitedOversPlanEditor({ xi, format, gender, value, onChange }: {
  xi: Player[];
  format: "t20" | "odi";
  gender: "male" | "female";
  value: BowlingPlan | undefined;
  onChange: (plan: BowlingPlan | undefined) => void;
}) {
  const cap = format === "t20" ? 4 : 10;
  const total = format === "t20" ? 20 : 50;
  const bowlers = useMemo(
    () => xi.filter(p => !p.isWicketKeeper || p.role === "all-rounder").sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr),
    [xi],
  );
  const byId = useMemo(() => new Map(xi.map(p => [p.id, p])), [xi]);
  // what the captain would do: his attack is the genuine bowlers (five at least), over by over
  const defaultSeq = useMemo(() => {
    const rank = rankByBowling(xi.map(p => ({ id: p.id, rating: p.effectiveBowlingOvr, keeper: !!p.isWicketKeeper, role: p.role })));
    const real = bowlers.filter(p => p.role !== "batsman");
    const attack = (real.length >= 5 ? real : bowlers.slice(0, 5)).map(p => ({ id: p.id, rank: rank.get(p.id) ?? 9, style: p.bowlingStyle, partTimer: p.role === "batsman" }));
    return modelPlanFor(format, gender, cap, attack, total);
  }, [xi, bowlers, format, gender, cap, total]);

  const plan: BowlingPlan = value ?? { powerplay: [], middle: [], death: [] };
  const set = (next: BowlingPlan) => {
    const empty = next.powerplay.length + next.middle.length + next.death.length + Object.keys(next.overs ?? {}).length === 0;
    onChange(empty ? undefined : next);
  };
  const toggle = (phase: "powerplay" | "middle" | "death", id: string) => {
    const cur = plan[phase];
    set({ ...plan, [phase]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] });
  };
  const fixOver = (o: number, id: string) => {
    const overs = { ...(plan.overs ?? {}) };
    if (id) overs[o] = id; else delete overs[o];
    set({ ...plan, overs: Object.keys(overs).length ? overs : undefined });
  };
  const startFromDefault = () => {
    const overs: Record<number, string> = {};
    defaultSeq.forEach((id, o) => { overs[o] = id; });
    set({ ...plan, overs });
  };

  const fixed = plan.overs ?? {};
  const counts = new Map<string, number>();
  for (const id of Object.values(fixed)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const warnings: string[] = [];
  for (const [id, n] of counts) if (n > cap) warnings.push(`${byId.get(id)?.name ?? id} is fixed to ${n} overs (the cap is ${cap})`);
  for (let o = 1; o < total; o++) if (fixed[o] && fixed[o] === fixed[o - 1]) warnings.push(`${byId.get(fixed[o])?.name ?? fixed[o]} is fixed to overs ${o} and ${o + 1}, back to back`);

  return (
    <div className="rounded-2xl border border-th bg-th-surface p-5" data-testid="bowling-plan">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-display font-semibold text-th-primary">Bowling plan</h3>
        <button type="button" onClick={() => onChange(undefined)} disabled={!value} data-testid="bowling-plan-reset"
          className="text-[11px] text-th-muted hover:text-th-primary font-display disabled:opacity-40">Back to the default</button>
      </div>
      <p className="text-[11px] text-th-faint font-display mb-3">
        {value
          ? (format === "odi" ? "Your plan: bowlers you pick for a phase bowl it (the best of them on rating, by turns); an over you fix goes to that bowler." : "Your plan: bowlers you pick for a phase bowl it (the captain chooses among them); an over you fix goes to that bowler.")
          : (format === "odi"
            ? "Default: the best bowlers on rating bowl, by turns. The strip shows how real captains share the overs (pace first, spin in the middle, the best pace bowlers at the death): start from it to bowl like them."
            : "Default: the captain bowls as real captains do (pace first, spin in the middle, the best pace bowlers at the death).")}
      </p>

      <div className="flex flex-wrap gap-1 mb-3" data-testid="bowling-plan-default" aria-label="Default plan over by over">
        {defaultSeq.map((id, o) => (
          <span key={o} title={`Over ${o + 1}: ${byId.get(id)?.name ?? ""}`}
            className="text-[9px] font-mono rounded bg-th-raised px-1 py-0.5 text-th-muted">{o + 1} {surname(byId.get(id)?.name ?? "?").slice(0, 4)}</span>
        ))}
      </div>

      <div className="space-y-2">
        {PHASES.map(ph => (
          <div key={ph.key}>
            <div className="text-[10px] uppercase tracking-wider font-display text-th-muted mb-1">{ph.label} <span className="normal-case text-th-faint">({ph.overs[format]})</span></div>
            <div className="flex flex-wrap gap-1">
              {bowlers.map(p => {
                const on = plan[ph.key].includes(p.id);
                return (
                  <button key={p.id} type="button" onClick={() => toggle(ph.key, p.id)} aria-pressed={on} data-testid={`plan-${ph.key}-${p.id}`}
                    className={`text-[11px] font-display rounded-full px-2 py-1 border transition-colors ${on ? "bg-orange-500/20 border-orange-500/60 text-th-primary" : "bg-th-raised border-transparent text-th-secondary hover:text-th-primary"}`}>
                    {surname(p.name)} <span className="text-th-faint">{KIND_LABEL[bowlerKind(p.bowlingStyle)]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <details className="mt-3" data-testid="bowling-plan-overs">
        <summary className="text-[11px] font-display text-th-muted cursor-pointer hover:text-th-primary">Fix individual overs</summary>
        <div className="mt-2 flex items-center gap-3">
          <button type="button" onClick={startFromDefault} data-testid="bowling-plan-from-default" className="text-[11px] font-display text-orange-400 hover:text-orange-300">Start from the default plan</button>
          {value?.overs && <button type="button" onClick={() => set({ ...plan, overs: undefined })} className="text-[11px] font-display text-th-muted hover:text-th-primary">Clear fixed overs</button>}
        </div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1">
          {Array.from({ length: total }, (_, o) => (
            <label key={o} className="flex items-center gap-1 text-[10px] font-mono text-th-faint">
              <span className="w-5 text-right">{o + 1}</span>
              <select value={fixed[o] ?? ""} onChange={e => fixOver(o, e.target.value)} data-testid={`plan-over-${o}`}
                className="flex-1 min-w-0 rounded bg-th-raised text-th-secondary text-[11px] font-display px-1 py-0.5 border border-th">
                <option value="">default</option>
                {bowlers.map(p => <option key={p.id} value={p.id}>{surname(p.name)}</option>)}
              </select>
            </label>
          ))}
        </div>
      </details>

      {warnings.length > 0 && <p className="text-amber-400 text-xs font-display mt-3" data-testid="bowling-plan-warnings">{warnings.join(" · ")}</p>}
    </div>
  );
}

export function BowlingPlanEditor(props: { xi: Player[]; format: PlanFormat; gender: "male" | "female"; value: BowlingPlan | undefined; onChange: (plan: BowlingPlan | undefined) => void }) {
  if (props.format === "test") {
    const bowlers = props.xi.filter(p => !p.isWicketKeeper && p.role !== "batsman").sort((a, b) => b.effectiveBowlingOvr - a.effectiveBowlingOvr);
    return <TestPlanEditor bowlers={bowlers} value={props.value} onChange={props.onChange} />;
  }
  return <LimitedOversPlanEditor {...props} format={props.format} />;
}
