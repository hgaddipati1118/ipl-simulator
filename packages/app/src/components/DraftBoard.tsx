/**
 * Draft board UI shared by the season draft, Draft Match and the multiplayer draft room:
 * clock + on-the-clock banner, filterable player pool, your squad with needs/validity,
 * a pick queue with auto-draft, and the round-by-round board.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  type DraftState, type DraftPlayer,
  getCurrentSeatId, getCurrentRound, getSquad, getSquadNeeds, getPickError,
  canFieldValidXI, isDraftBowlingOption,
} from "@ipl-sim/engine";
import { ovrColorClass, roleLabel, bowlingStyleLabel } from "../ui-utils";

export interface SeatStyle {
  short: string;
  color: string;
}

interface Props {
  draft: DraftState;
  /** Seats this viewer controls ([] = spectator) */
  mySeatIds: string[];
  seatStyles?: Record<string, SeatStyle>;
  /** Seat id → display name of the person/AI in it */
  seatOwners?: Record<string, string>;
  secondsLeft: number | null;
  onPick?: (playerId: string) => void;
  queue: string[];
  onQueueChange: (queue: string[]) => void;
  autoDraft: boolean;
  onAutoDraftChange: (on: boolean) => void;
  announcements?: string[];
  /** Max overseas in a playing XI (validity panel) */
  maxOverseasInXI?: number;
  minBowlingInXI?: number;
  headerActions?: ReactNode;
  pickError?: string | null;
}

type RoleFilter = "all" | "bat" | "bowl" | "ar" | "wk";
type SortKey = "overall" | "battingOvr" | "bowlingOvr" | "age" | "value";

const ROW_LIMIT = 120;

export function DraftBoard({
  draft, mySeatIds, seatStyles = {}, seatOwners = {}, secondsLeft, onPick, queue, onQueueChange,
  autoDraft, onAutoDraftChange, announcements = [], maxOverseasInXI, minBowlingInXI = 5,
  headerActions, pickError,
}: Props) {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [origin, setOrigin] = useState<"all" | "domestic" | "overseas">("all");
  const [country, setCountry] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [legalOnly, setLegalOnly] = useState(false);
  const [view, setView] = useState<"pool" | "board">("pool");

  const currentSeatId = getCurrentSeatId(draft);
  const round = getCurrentRound(draft);
  const mySeat = mySeatIds[0] ?? null;
  const myTurn = !!currentSeatId && mySeatIds.includes(currentSeatId) && draft.status === "in-progress";
  const currentSeat = draft.seats.find(s => s.id === currentSeatId);

  const countries = useMemo(
    () => [...new Set(draft.pool.map(p => p.country))].sort(),
    [draft.pool],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = draft.pool.filter(p => {
      if (draft.taken[p.id]) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (role === "wk" && !p.isWicketKeeper) return false;
      if (role === "bat" && (p.role !== "batsman" || p.isWicketKeeper)) return false;
      if (role === "bowl" && p.role !== "bowler") return false;
      if (role === "ar" && p.role !== "all-rounder") return false;
      if (origin === "domestic" && p.isInternational) return false;
      if (origin === "overseas" && !p.isInternational) return false;
      if (country !== "all" && p.country !== country) return false;
      return true;
    });
    list.sort((a, b) => sortKey === "age" ? a.age - b.age : ((b[sortKey] ?? 0) as number) - ((a[sortKey] ?? 0) as number));
    // Legality checks scan the pool, so only run them for rows we will actually show.
    const out: { p: DraftPlayer; err: string | null }[] = [];
    for (const p of list) {
      const err = mySeat ? getPickError(draft, mySeat, p.id) : null;
      if (legalOnly && err) continue;
      out.push({ p, err });
      if (out.length >= ROW_LIMIT) break;
    }
    return out;
  }, [draft, search, role, origin, country, sortKey, legalOnly, mySeat]);

  const mySquad = mySeat ? getSquad(draft, mySeat) : [];
  const needs = mySeat ? getSquadNeeds(draft, mySeat) : null;
  const xiReady = mySquad.length >= 11 && canFieldValidXI(mySquad, {
    minWicketKeepers: 1, minBowlingOptions: minBowlingInXI, maxOverseasInXI,
  });

  const byId = useMemo(() => new Map(draft.pool.map(p => [p.id, p])), [draft.pool]);
  const queuePlayers = queue.map(id => byId.get(id)).filter((p): p is DraftPlayer => !!p && !draft.taken[p.id]);

  const toggleQueue = (id: string) => {
    onQueueChange(queue.includes(id) ? queue.filter(x => x !== id) : [...queue, id]);
  };
  const moveQueue = (id: string, dir: -1 | 1) => {
    const i = queue.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= queue.length) return;
    const next = [...queue];
    [next[i], next[j]] = [next[j], next[i]];
    onQueueChange(next);
  };

  const styleOf = (seatId: string): SeatStyle => seatStyles[seatId] ?? {
    short: draft.seats.find(s => s.id === seatId)?.name.slice(0, 3).toUpperCase() ?? seatId,
    color: "#64748b",
  };
  const totalPicks = draft.order.length;
  const isUrgent = secondsLeft !== null && secondsLeft <= 5;

  return (
    <div className="space-y-4">
      {/* ── On the clock ── */}
      <div className={`rounded-2xl border p-4 sm:p-5 flex flex-col gap-3 sm:flex-row sm:items-center ${
        myTurn ? "border-orange-500/40 bg-orange-500/[0.07]" : "border-th bg-th-surface"
      }`}>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted">
            {draft.status === "complete"
              ? "Draft complete"
              : `Round ${round} of ${draft.config.rounds} · Pick ${draft.picks.length + 1} of ${totalPicks}`}
          </div>
          <div className="text-xl font-display font-bold text-th-primary mt-0.5 truncate">
            {draft.status === "complete" ? "All squads are set"
              : draft.status === "paused" ? "Paused"
              : myTurn ? "You're on the clock"
              : currentSeat ? `${currentSeat.name}${seatOwners[currentSeat.id] ? ` (${seatOwners[currentSeat.id]})` : ""} is picking…` : ""}
          </div>
          {pickError && <div className="text-xs text-red-400 font-display mt-1">{pickError}</div>}
        </div>
        {secondsLeft !== null && draft.status === "in-progress" && (
          <div className={`text-3xl font-mono font-bold stat-num ${isUrgent ? "text-red-400 animate-pulse" : "text-th-primary"}`}>
            0:{String(Math.max(0, secondsLeft)).padStart(2, "0")}
          </div>
        )}
        <div className="flex flex-wrap gap-2">{headerActions}</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* ── Pool / board ── */}
        <div className="lg:col-span-8 rounded-2xl border border-th bg-th-surface p-4">
          <div className="flex items-center gap-2 mb-3">
            {(["pool", "board"] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-display font-semibold transition-colors ${
                  view === v ? "bg-white/10 text-th-primary" : "text-th-muted hover:text-th-primary hover:bg-th-hover"
                }`}>
                {v === "pool" ? "Player pool" : "Draft board"}
              </button>
            ))}
            <span className="ml-auto text-[10px] font-mono text-th-faint">
              {draft.pool.length - Object.keys(draft.taken).length} available
            </span>
          </div>

          {view === "pool" ? (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search players"
                  className="flex-1 min-w-[140px] bg-th-raised border border-th rounded-lg px-3 py-1.5 text-xs text-th-primary font-display focus:outline-none focus:border-orange-500/50" />
                <select value={role} onChange={e => setRole(e.target.value as RoleFilter)}
                  className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-xs text-th-secondary font-display">
                  <option value="all">All roles</option><option value="bat">Batters</option>
                  <option value="wk">Keepers</option><option value="ar">All-rounders</option><option value="bowl">Bowlers</option>
                </select>
                <select value={origin} onChange={e => setOrigin(e.target.value as typeof origin)}
                  className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-xs text-th-secondary font-display">
                  <option value="all">Domestic + overseas</option><option value="domestic">Domestic</option><option value="overseas">Overseas</option>
                </select>
                <select value={country} onChange={e => setCountry(e.target.value)}
                  className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-xs text-th-secondary font-display max-w-[130px]">
                  <option value="all">All countries</option>
                  {countries.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)}
                  className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-xs text-th-secondary font-display">
                  <option value="overall">Sort: OVR</option><option value="battingOvr">Sort: Batting</option>
                  <option value="bowlingOvr">Sort: Bowling</option><option value="age">Sort: Youngest</option><option value="value">Sort: Value</option>
                </select>
                {mySeat && (
                  <label className="flex items-center gap-1.5 text-xs text-th-muted font-display cursor-pointer">
                    <input type="checkbox" checked={legalOnly} onChange={e => setLegalOnly(e.target.checked)} className="accent-orange-500" />
                    Pickable only
                  </label>
                )}
              </div>
              <div className="overflow-x-auto max-h-[560px] overflow-y-auto" data-testid="draft-pool">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-th-surface">
                    <tr className="text-[10px] uppercase tracking-wider text-th-muted font-display">
                      <th className="text-left py-1.5 pr-2">Player</th>
                      <th className="text-left px-1">Role</th>
                      <th className="text-right px-1">OVR</th>
                      <th className="text-right px-1">BAT</th>
                      <th className="text-right px-1">BOWL</th>
                      <th className="text-right px-1">Age</th>
                      <th className="text-right px-1">Value</th>
                      <th className="text-right pl-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ p, err }) => (
                      <tr key={p.id} className={`border-t border-th ${err && myTurn ? "opacity-45" : ""}`} title={err ?? undefined}>
                        <td className="py-1.5 pr-2">
                          <div className="font-display font-medium text-th-primary truncate max-w-[180px]">
                            {p.name}
                            {p.isWicketKeeper && <span className="text-cyan-400/80 text-[9px] ml-1 font-semibold">WK</span>}
                            {p.isInternational && <span className="text-orange-400/80 text-[9px] ml-1 font-semibold">OS</span>}
                          </div>
                          <div className="text-[10px] text-th-faint">{p.country}{p.bowlingStyle && bowlingStyleLabel(p.bowlingStyle) ? ` · ${bowlingStyleLabel(p.bowlingStyle)}` : ""}</div>
                        </td>
                        <td className="px-1 text-th-muted">{roleLabel(p.role)}</td>
                        <td className={`px-1 text-right font-mono font-bold ${ovrColorClass(p.overall)}`}>{p.overall}</td>
                        <td className="px-1 text-right font-mono text-th-secondary">{p.battingOvr}</td>
                        <td className="px-1 text-right font-mono text-th-secondary">{p.bowlingOvr}</td>
                        <td className="px-1 text-right font-mono text-th-muted">{p.age}</td>
                        <td className="px-1 text-right font-mono text-amber-400/80">{p.value?.toFixed(1) ?? "–"}</td>
                        <td className="pl-1 text-right whitespace-nowrap">
                          {mySeat && (
                            <button onClick={() => toggleQueue(p.id)} title={queue.includes(p.id) ? "Remove from queue" : "Add to queue"}
                              className={`px-1.5 py-1 rounded text-sm ${queue.includes(p.id) ? "text-amber-400" : "text-th-faint hover:text-amber-400"}`}>
                              {queue.includes(p.id) ? "★" : "☆"}
                            </button>
                          )}
                          {onPick && (
                            <button onClick={() => onPick(p.id)} disabled={!myTurn || !!err}
                              data-testid="draft-pick-button"
                              className="ml-1 px-2.5 py-1 rounded-lg text-[11px] font-display font-semibold bg-gradient-to-r from-orange-500 to-amber-500 text-white disabled:from-transparent disabled:to-transparent disabled:bg-th-raised disabled:text-th-faint transition-colors">
                              Draft
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <p className="text-th-faint text-xs font-display py-6 text-center">No players match those filters</p>}
                {rows.length === ROW_LIMIT && <p className="text-th-faint text-[10px] font-display py-2 text-center">Showing the top {ROW_LIMIT}. Filter or search to see more.</p>}
              </div>
            </>
          ) : (
            <div className="overflow-auto max-h-[600px]">
              <table className="text-[11px] border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th className="text-th-faint font-mono text-[10px] text-left">Rd</th>
                    {draft.seats.map(s => (
                      <th key={s.id} className="min-w-[96px] text-left">
                        <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: styleOf(s.id).color }} />
                        <span className={`font-display font-semibold ${mySeatIds.includes(s.id) ? "text-orange-400" : "text-th-secondary"}`}>{styleOf(s.id).short}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: draft.config.rounds }, (_, r) => (
                    <tr key={r}>
                      <td className="text-th-faint font-mono text-[10px] pr-1">{r + 1}</td>
                      {draft.seats.map(s => {
                        const pid = draft.squads[s.id]?.[r];
                        const p = pid ? byId.get(pid) : undefined;
                        const kept = pid && draft.keepers[s.id]?.includes(pid);
                        const isNow = !pid && s.id === currentSeatId && (draft.squads[s.id]?.length ?? 0) === r;
                        return (
                          <td key={s.id} className={`rounded-md px-1.5 py-1 align-top ${isNow ? "ring-1 ring-orange-500/60 bg-orange-500/[0.06]" : "bg-th-raised"}`}>
                            {p ? (
                              <div className="truncate max-w-[110px]" title={p.name}>
                                <span className={`font-mono mr-1 ${ovrColorClass(p.overall)}`}>{p.overall}</span>
                                <span className="text-th-primary">{p.name.split(" ").slice(-1)[0]}</span>
                                {kept && <span className="text-th-faint ml-1">K</span>}
                              </div>
                            ) : <span className="text-th-faint">{isNow ? "…" : ""}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Squad, queue, feed ── */}
        <div className="lg:col-span-4 space-y-4">
          {mySeat && needs && (
            <div className="rounded-2xl border border-th bg-th-surface p-4" data-testid="draft-my-squad">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider">Your squad</h3>
                <span className="text-[10px] font-mono text-th-muted">{mySquad.length}/{draft.config.rounds}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3 text-[10px] font-display">
                <Need ok={needs.wicketKeepers === 0} label={needs.wicketKeepers ? `Need ${needs.wicketKeepers} WK` : "Keepers ✓"} />
                <Need ok={needs.bowlingOptions === 0} label={needs.bowlingOptions ? `Need ${needs.bowlingOptions} bowlers` : "Bowlers ✓"} />
                {needs.overseasLeft !== Infinity && <Need ok label={`${needs.overseasLeft} overseas left`} />}
                {mySquad.length >= 11 && <Need ok={xiReady} label={xiReady ? "Legal XI ✓" : "No legal XI yet"} />}
              </div>
              <div className="space-y-0.5 max-h-[260px] overflow-y-auto">
                {mySquad.map(p => (
                  <div key={p.id} className="flex items-center gap-2 text-xs py-0.5">
                    <span className={`font-mono w-6 text-right ${ovrColorClass(p.overall)}`}>{p.overall}</span>
                    <span className="text-th-primary font-display truncate flex-1">{p.name}</span>
                    <span className="text-[10px] text-th-faint">
                      {p.isWicketKeeper ? "WK" : isDraftBowlingOption(p) ? (p.role === "all-rounder" ? "AR" : "BOWL") : "BAT"}
                      {p.isInternational ? " · OS" : ""}
                    </span>
                  </div>
                ))}
                {mySquad.length === 0 && <p className="text-th-faint text-xs font-display">No picks yet</p>}
              </div>
            </div>
          )}

          {mySeat && (
            <div className="rounded-2xl border border-th bg-th-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider">Queue</h3>
                <label className="flex items-center gap-1.5 text-[11px] text-th-muted font-display cursor-pointer">
                  <input type="checkbox" checked={autoDraft} onChange={e => onAutoDraftChange(e.target.checked)} className="accent-orange-500" data-testid="draft-autodraft" />
                  Auto-draft
                </label>
              </div>
              <p className="text-[10px] text-th-faint font-display mb-2">
                When the clock runs out (or auto-draft is on) you get the first pickable player here, otherwise the best available.
              </p>
              <div className="space-y-1 max-h-[180px] overflow-y-auto">
                {queuePlayers.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-1.5 text-xs">
                    <span className="text-th-faint font-mono w-4">{i + 1}</span>
                    <span className="text-th-primary font-display truncate flex-1">{p.name}</span>
                    <button onClick={() => moveQueue(p.id, -1)} className="text-th-faint hover:text-th-primary px-1">↑</button>
                    <button onClick={() => moveQueue(p.id, 1)} className="text-th-faint hover:text-th-primary px-1">↓</button>
                    <button onClick={() => toggleQueue(p.id)} className="text-th-faint hover:text-red-400 px-1">✕</button>
                  </div>
                ))}
                {queuePlayers.length === 0 && <p className="text-th-faint text-xs font-display">Star players in the pool to queue them</p>}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-th bg-th-surface p-4">
            <h3 className="text-xs font-display font-semibold text-th-muted uppercase tracking-wider mb-2">Latest picks</h3>
            <div className="space-y-1 max-h-[220px] overflow-y-auto" data-testid="draft-feed">
              {(announcements.length > 0 ? announcements : [...draft.picks].reverse().slice(0, 12).map(pk => {
                const p = byId.get(pk.playerId);
                return `#${pk.pickNo} ${styleOf(pk.seatId).short}: ${p?.name ?? pk.playerId}${pk.auto ? " (auto)" : ""}`;
              })).map((line, i) => (
                <div key={i} className="text-xs text-th-secondary font-display">{line}</div>
              ))}
              {draft.picks.length === 0 && announcements.length === 0 && <p className="text-th-faint text-xs font-display">No picks yet</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Need({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full border ${ok ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/[0.06]" : "border-amber-500/30 text-amber-400 bg-amber-500/[0.06]"}`}>
      {label}
    </span>
  );
}
