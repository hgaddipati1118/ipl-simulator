import { useEffect, useMemo, useState } from "react";
import { ovrBgClass, roleLabel } from "../ui-utils";
import { LOWER_TIERS, overallsOf, poolLoader, type ExtendedPlayer, type PoolGender } from "../extended-pool";

const TIER_LABEL: Record<string, string> = {
  senior: "Senior", tier0: "2nd XI / other", tier1: "University", tier2: "Club / league", tier3: "Youth", tier4: "Veterans",
};

interface Props {
  /** Sign a player as a free agent in the current league */
  onAddToPool: (player: ExtendedPlayer) => void;
}

/**
 * Search of the full CricketArchive database (every rated player, loaded on demand): the pool bundled with the game only
 * has players with an ESPN profile. Results are capped; lower-level cricket is opt-in (it is large).
 */
export function DatabaseSearch({ onAddToPool }: Props) {
  const [open, setOpen] = useState(false);
  const [gender, setGender] = useState<PoolGender>("men");
  const [lower, setLower] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ExtendedPlayer[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || counts) return;
    poolLoader.counts().then(setCounts).catch(() => setError("The player database could not be loaded."));
  }, [open, counts]);

  useEffect(() => {
    if (!open || query.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      poolLoader.search(query, gender, lower ? ["senior", ...LOWER_TIERS] : ["senior"], 50)
        .then(r => { if (!cancelled) { setResults(r); setError(null); } })
        .catch(() => { if (!cancelled) setError("The player database could not be loaded."); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, query, gender, lower]);

  const total = useMemo(() => {
    if (!counts) return null;
    const tiers = lower ? ["senior", ...LOWER_TIERS] : ["senior"];
    return tiers.reduce((t, k) => t + (counts[`${gender}/${k}`] ?? 0), 0);
  }, [counts, gender, lower]);

  return (
    <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5 mt-6">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between text-left">
        <span>
          <span className="block text-th-primary text-sm font-semibold uppercase tracking-wider">Full player database</span>
          <span className="block text-th-faint text-xs mt-1">Every rated cricketer on CricketArchive, beyond the players bundled with the game. Search and sign them as free agents.</span>
        </span>
        <span className="text-th-muted text-xs font-display">{open ? "Hide" : "Open"}</span>
      </button>
      {open && (
        <div className="mt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <input
              type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name or country (2+ letters)"
              className="w-full rounded-xl border border-th bg-th-surface py-2 px-3 text-sm text-th-primary font-display focus:outline-none focus:border-th-strong sm:max-w-xs"
            />
            <select value={gender} onChange={e => setGender(e.target.value as PoolGender)}
              className="w-full rounded-xl border border-th bg-th-surface px-3 py-2 text-sm text-th-primary font-display sm:w-auto">
              <option value="men">Men</option>
              <option value="women">Women</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-th-secondary font-display">
              <input type="checkbox" checked={lower} onChange={e => setLower(e.target.checked)} className="accent-orange-500" />
              Include lower-level cricket
            </label>
            {total !== null && <span className="text-th-faint text-xs stat-num">{total.toLocaleString()} players</span>}
          </div>
          {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
          {busy && <p className="text-th-faint text-xs mt-3">Searching...</p>}
          {results.length > 0 && (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-sm min-w-[480px]">
                <thead>
                  <tr className="text-th-muted text-[11px] uppercase font-display tracking-wider border-b border-th">
                    <th className="text-left px-2 py-2">Player</th>
                    <th className="text-center px-2 py-2">Level</th>
                    <th className="text-center px-2 py-2">Role</th>
                    <th className="text-center px-2 py-2">OVR</th>
                    <th className="text-center px-2 py-2 hidden sm:table-cell">BAT</th>
                    <th className="text-center px-2 py-2 hidden sm:table-cell">BWL</th>
                    <th className="text-center px-2 py-2">Age</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {results.map(p => {
                    const o = overallsOf(p);
                    return (
                      <tr key={p.id} className="border-t border-th">
                        <td className="px-2 py-2 text-th-primary font-display text-xs sm:text-sm">
                          {p.name}<span className="text-th-faint text-[10px] ml-1">{p.country}</span>
                          {p.isWicketKeeper && <span className="text-cyan-400/70 text-[10px] ml-1 font-semibold">WK</span>}
                        </td>
                        <td className="text-center px-2 py-2 text-th-muted text-[11px]">{TIER_LABEL[p.tier] ?? p.tier}</td>
                        <td className="text-center px-2 py-2 text-th-muted text-[11px]">{roleLabel(p.role)}</td>
                        <td className="text-center px-2 py-2"><span className={`ovr-badge text-sm inline-block min-w-[28px] rounded-md px-1 py-0.5 ${ovrBgClass(o.overall)}`}>{o.overall}</span></td>
                        <td className="text-center px-2 py-2 stat-num text-orange-300/60 hidden sm:table-cell">{o.batting}</td>
                        <td className="text-center px-2 py-2 stat-num text-purple-300/60 hidden sm:table-cell">{o.bowling}</td>
                        <td className="text-center px-2 py-2 stat-num text-th-muted">{p.age}</td>
                        <td className="text-right px-2 py-2">
                          <button
                            disabled={added.has(p.id)}
                            onClick={() => { onAddToPool(p); setAdded(new Set(added).add(p.id)); }}
                            className="rounded-lg border border-th bg-th-raised px-2 py-1 text-[10px] font-display font-medium text-th-secondary hover:text-th-primary hover:bg-th-hover disabled:opacity-50"
                          >
                            {added.has(p.id) ? "Added" : "Add to free agents"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!busy && query.trim().length >= 2 && results.length === 0 && !error && <p className="text-th-faint text-xs mt-3">No players found.</p>}
        </div>
      )}
    </div>
  );
}
