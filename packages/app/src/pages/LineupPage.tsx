import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Team, Player } from "@ipl-sim/engine";

interface Props {
  team: Team;
  onConfirm: (xi: string[], battingOrder: string[], bowlingOrder: string[]) => void;
}

export function LineupPage({ team, onConfirm }: Props) {
  const navigate = useNavigate();
  const available = useMemo(() => team.roster.filter(p => !p.injured), [team]);
  const injured = useMemo(() => team.roster.filter(p => p.injured), [team]);

  // Initialize from saved team state or auto-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (team.userPlayingXI && team.userPlayingXI.length === 11) {
      // Validate saved selection (remove any now-injured players)
      const valid = team.userPlayingXI.filter(id => available.some(p => p.id === id));
      if (valid.length === 11) return new Set(valid);
    }
    const autoXI = team.autoSelectPlayingXI();
    return new Set(autoXI.map(p => p.id));
  });

  const [battingOrder, setBattingOrder] = useState<string[]>(() => {
    if (team.userBattingOrder && team.userBattingOrder.length > 0) {
      return team.userBattingOrder.filter(id => selectedIds.has(id));
    }
    const xi = team.autoSelectPlayingXI();
    return team.autoBattingOrder(xi).map(p => p.id);
  });

  const [bowlingOrder, setBowlingOrder] = useState<string[]>(() => {
    if (team.userBowlingOrder && team.userBowlingOrder.length > 0) {
      return team.userBowlingOrder.filter(id => selectedIds.has(id));
    }
    const xi = team.autoSelectPlayingXI();
    return team.autoBowlingOrder(xi).map(p => p.id);
  });

  const [activeTab, setActiveTab] = useState<"xi" | "batting" | "bowling">("xi");

  // Derive selected players
  const selectedPlayers = useMemo(
    () => Array.from(selectedIds).map(id => team.roster.find(p => p.id === id)!).filter(Boolean),
    [selectedIds, team]
  );

  const overseasCount = selectedPlayers.filter(p => p.isInternational).length;
  const wkCount = selectedPlayers.filter(p => p.isWicketKeeper).length;
  const bowlerCount = selectedPlayers.filter(p => p.role === "bowler" || p.role === "all-rounder").length;

  // Validation
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (selectedIds.size !== 11) errors.push(`Select exactly 11 players (${selectedIds.size}/11)`);
    if (overseasCount > 4) errors.push(`Max 4 overseas players (${overseasCount}/4)`);
    if (wkCount < 1) errors.push("Need at least 1 wicket-keeper");
    return errors;
  }, [selectedIds.size, overseasCount, wkCount]);

  const isValid = validationErrors.length === 0;

  // Toggle player in XI
  const togglePlayer = useCallback((playerId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      return next;
    });
  }, []);

  // Sync batting/bowling orders when XI changes
  const syncOrders = useCallback((newIds: Set<string>) => {
    // Update batting order: keep existing order for selected, remove deselected
    setBattingOrder(prev => {
      const kept = prev.filter(id => newIds.has(id));
      const added = Array.from(newIds).filter(id => !kept.includes(id));
      return [...kept, ...added];
    });
    // Update bowling order: keep bowlers that are still selected
    setBowlingOrder(prev => {
      const bowlerIds = Array.from(newIds).filter(id => {
        const p = team.roster.find(r => r.id === id);
        return p && (p.role === "bowler" || p.role === "all-rounder");
      });
      const kept = prev.filter(id => newIds.has(id) && bowlerIds.includes(id));
      const added = bowlerIds.filter(id => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [team]);

  const handleToggle = useCallback((playerId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      syncOrders(next);
      return next;
    });
  }, [syncOrders]);

  // Auto-select best XI
  const handleAutoSelect = useCallback(() => {
    const autoXI = team.autoSelectPlayingXI();
    const ids = new Set(autoXI.map(p => p.id));
    setSelectedIds(ids);
    setBattingOrder(team.autoBattingOrder(autoXI).map(p => p.id));
    setBowlingOrder(team.autoBowlingOrder(autoXI).map(p => p.id));
  }, [team]);

  // Auto-sort batting order
  const handleAutoSortBatting = useCallback(() => {
    const xi = Array.from(selectedIds).map(id => team.roster.find(p => p.id === id)!).filter(Boolean);
    setBattingOrder(team.autoBattingOrder(xi).map(p => p.id));
  }, [selectedIds, team]);

  // Auto-generate bowling order
  const handleAutoSortBowling = useCallback(() => {
    const xi = Array.from(selectedIds).map(id => team.roster.find(p => p.id === id)!).filter(Boolean);
    setBowlingOrder(team.autoBowlingOrder(xi).map(p => p.id));
  }, [selectedIds, team]);

  // Move player up/down in order
  const moveInOrder = useCallback((order: string[], setOrder: (v: string[]) => void, index: number, direction: -1 | 1) => {
    const newOrder = [...order];
    const swapIdx = index + direction;
    if (swapIdx < 0 || swapIdx >= newOrder.length) return;
    [newOrder[index], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[index]];
    setOrder(newOrder);
  }, []);

  // Confirm lineup
  const handleConfirm = useCallback(() => {
    const xiIds = Array.from(selectedIds);
    // Ensure batting order only contains selected players
    const finalBatting = battingOrder.filter(id => selectedIds.has(id));
    const missingBat = xiIds.filter(id => !finalBatting.includes(id));
    const fullBatting = [...finalBatting, ...missingBat];

    // Ensure bowling order only contains selected bowlers
    const finalBowling = bowlingOrder.filter(id => selectedIds.has(id));

    onConfirm(xiIds, fullBatting, finalBowling);
  }, [selectedIds, battingOrder, bowlingOrder, onConfirm]);

  const findPlayer = (id: string) => team.roster.find(p => p.id === id);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-th-primary">Lineup Management</h2>
          <p className="text-th-secondary mt-1">
            Set your playing XI, batting order, and bowling plan for{" "}
            <span style={{ color: team.config.primaryColor }} className="font-semibold">{team.name}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              // Auto-select best XI and immediately confirm
              const autoXI = team.autoSelectPlayingXI(4);
              const autoIds = autoXI.map(p => p.id);
              const autoBat = team.autoBattingOrder(autoXI).map(p => p.id);
              const autoBowl = team.autoBowlingOrder(autoXI).map(p => p.id);
              onConfirm(autoIds, autoBat, autoBowl);
            }}
            className="px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-lg text-sm transition-all"
          >
            Quick Start
          </button>
          <button
            onClick={() => navigate("/season")}
            className="text-th-secondary hover:text-th-primary text-sm"
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Injury alerts */}
      {injured.length > 0 && (
        <div className="bg-red-950/30 border border-red-800/50 rounded-lg p-4 mb-6">
          <h3 className="text-red-400 font-semibold text-sm mb-2">Injured Players</h3>
          <div className="flex flex-wrap gap-3">
            {injured.map(p => (
              <div key={p.id} className="flex items-center gap-2 text-sm">
                <span className="text-red-300">{p.name}</span>
                <span className="text-red-500/70 text-xs">
                  {p.injuryType ?? "injury"} ({p.injuryGamesLeft} {p.injuryGamesLeft === 1 ? "match" : "matches"})
                </span>
                <SeverityBadge severity={p.injurySeverity ?? "minor"} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-th-surface rounded-lg p-1 w-fit">
        {(["xi", "batting", "bowling"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab
                ? "bg-blue-600 text-white"
                : "text-th-secondary hover:text-th-primary hover:bg-th-hover"
            }`}
          >
            {tab === "xi" ? "Playing XI" : tab === "batting" ? "Batting Order" : "Bowling Order"}
          </button>
        ))}
      </div>

      {/* Validation */}
      {validationErrors.length > 0 && (
        <div className="bg-yellow-950/30 border border-yellow-800/50 rounded-lg p-3 mb-4">
          {validationErrors.map((err, i) => (
            <p key={i} className="text-yellow-400 text-sm">{err}</p>
          ))}
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-6 mb-4 text-sm">
        <span className={`${selectedIds.size === 11 ? "text-green-400" : "text-yellow-400"}`}>
          {selectedIds.size}/11 selected
        </span>
        <span className={`${overseasCount <= 4 ? "text-blue-400" : "text-red-400"}`}>
          {overseasCount}/4 overseas
        </span>
        <span className={`${wkCount >= 1 ? "text-th-secondary" : "text-red-400"}`}>
          {wkCount} WK
        </span>
        <span className="text-th-secondary">
          {bowlerCount} bowlers/AR
        </span>
      </div>

      {/* Content based on active tab */}
      {activeTab === "xi" && (
        <PlayingXITab
          available={available}
          injured={injured}
          selectedIds={selectedIds}
          onToggle={handleToggle}
          onAutoSelect={handleAutoSelect}
        />
      )}

      {activeTab === "batting" && (
        <BattingOrderTab
          battingOrder={battingOrder.filter(id => selectedIds.has(id))}
          findPlayer={findPlayer}
          onMove={(idx, dir) => moveInOrder(
            battingOrder.filter(id => selectedIds.has(id)),
            (newOrder) => setBattingOrder(newOrder),
            idx,
            dir
          )}
          onAutoSort={handleAutoSortBatting}
        />
      )}

      {activeTab === "bowling" && (
        <BowlingOrderTab
          bowlingOrder={bowlingOrder.filter(id => selectedIds.has(id))}
          findPlayer={findPlayer}
          selectedIds={selectedIds}
          team={team}
          onMove={(idx, dir) => moveInOrder(
            bowlingOrder.filter(id => selectedIds.has(id)),
            (newOrder) => setBowlingOrder(newOrder),
            idx,
            dir
          )}
          onAutoGenerate={handleAutoSortBowling}
        />
      )}

      {/* Confirm button */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={handleConfirm}
          disabled={!isValid}
          className={`px-8 py-3 rounded-lg font-semibold text-lg transition-colors ${
            isValid
              ? "bg-green-600 hover:bg-green-500 text-white"
              : "bg-th-raised text-th-muted cursor-not-allowed"
          }`}
        >
          Lock In Lineup
        </button>
      </div>
    </div>
  );
}

// ---- Sub-components ----

function PlayingXITab({
  available,
  injured,
  selectedIds,
  onToggle,
  onAutoSelect,
}: {
  available: Player[];
  injured: Player[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onAutoSelect: () => void;
}) {
  const sorted = useMemo(
    () => [...available].sort((a, b) => b.overall - a.overall),
    [available]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">Squad</h3>
        <button
          onClick={onAutoSelect}
          className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs rounded-md transition-colors"
        >
          Auto Select
        </button>
      </div>

      <div className="bg-th-surface rounded-xl border border-th overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-th-muted text-xs uppercase bg-th-raised">
              <th className="w-10 px-3 py-2"></th>
              <th className="text-left px-3 py-2">Player</th>
              <th className="text-center px-2 py-2">Role</th>
              <th className="text-center px-2 py-2">OVR</th>
              <th className="text-center px-2 py-2">BAT</th>
              <th className="text-center px-2 py-2">BWL</th>
              <th className="text-center px-2 py-2">Age</th>
              <th className="text-center px-2 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(p => {
              const isSelected = selectedIds.has(p.id);
              return (
                <tr
                  key={p.id}
                  onClick={() => onToggle(p.id)}
                  className={`border-t border-th cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-blue-950/20 hover:bg-blue-950/30 border-l-2 border-l-blue-500"
                      : "hover:bg-th-hover border-l-2 border-l-transparent"
                  }`}
                >
                  <td className="px-3 py-2 text-center">
                    <div
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center text-xs ${
                        isSelected
                          ? "bg-blue-600 border-blue-500 text-white"
                          : "border-th-strong text-transparent"
                      }`}
                    >
                      {isSelected && "\u2713"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-th-primary font-medium">{p.name}</span>
                      {p.isInternational && (
                        <span className="text-blue-400 text-[10px] bg-blue-400/10 px-1.5 py-0.5 rounded">OS</span>
                      )}
                      {p.isWicketKeeper && (
                        <span className="text-cyan-400 text-[10px] bg-cyan-400/10 px-1.5 py-0.5 rounded">WK</span>
                      )}
                    </div>
                    <span className="text-th-faint text-xs">{p.country}</span>
                  </td>
                  <td className="text-center px-2 py-2">
                    <RoleBadge role={p.role} />
                  </td>
                  <td className="text-center px-2 py-2">
                    <span className={`font-bold ${ovrColor(p.overall)}`}>{p.overall}</span>
                  </td>
                  <td className="text-center px-2 py-2 text-th-secondary">{p.battingOvr}</td>
                  <td className="text-center px-2 py-2 text-th-secondary">{p.bowlingOvr}</td>
                  <td className="text-center px-2 py-2 text-th-muted">{p.age}</td>
                  <td className="text-center px-2 py-2 text-green-400 text-xs">Available</td>
                </tr>
              );
            })}
            {/* Injured players (grayed out) */}
            {injured.map(p => (
              <tr key={p.id} className="border-t border-th opacity-40 cursor-not-allowed">
                <td className="px-3 py-2 text-center">
                  <div className="w-5 h-5 rounded border-2 border-red-800 flex items-center justify-center text-xs text-red-500">
                    X
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-red-300 font-medium">{p.name}</span>
                    {p.isInternational && (
                      <span className="text-blue-400/50 text-[10px] bg-blue-400/5 px-1.5 py-0.5 rounded">OS</span>
                    )}
                    {p.isWicketKeeper && (
                      <span className="text-cyan-400/50 text-[10px] bg-cyan-400/5 px-1.5 py-0.5 rounded">WK</span>
                    )}
                  </div>
                  <span className="text-th-faint text-xs">{p.country}</span>
                </td>
                <td className="text-center px-2 py-2">
                  <RoleBadge role={p.role} />
                </td>
                <td className="text-center px-2 py-2">
                  <span className="font-bold text-th-faint">{p.overall}</span>
                </td>
                <td className="text-center px-2 py-2 text-th-faint">{p.battingOvr}</td>
                <td className="text-center px-2 py-2 text-th-faint">{p.bowlingOvr}</td>
                <td className="text-center px-2 py-2 text-th-faint">{p.age}</td>
                <td className="text-center px-2 py-2">
                  <span className="text-red-400 text-xs">
                    {p.injuryType ?? "Injured"} ({p.injuryGamesLeft}m)
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BattingOrderTab({
  battingOrder,
  findPlayer,
  onMove,
  onAutoSort,
}: {
  battingOrder: string[];
  findPlayer: (id: string) => Player | undefined;
  onMove: (idx: number, dir: -1 | 1) => void;
  onAutoSort: () => void;
}) {
  if (battingOrder.length === 0) {
    return (
      <div className="text-th-muted text-center py-12">
        Select your playing XI first to set batting order
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">
          Batting Order ({battingOrder.length} batters)
        </h3>
        <button
          onClick={onAutoSort}
          className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs rounded-md transition-colors"
        >
          Auto Sort
        </button>
      </div>

      <div className="bg-th-surface rounded-xl border border-th overflow-hidden">
        {battingOrder.map((id, idx) => {
          const player = findPlayer(id);
          if (!player) return null;

          let posLabel = "";
          if (idx < 2) posLabel = "Opener";
          else if (idx < 5) posLabel = "Top Order";
          else if (idx < 8) posLabel = "Middle Order";
          else posLabel = "Lower Order";

          return (
            <div
              key={id}
              className="flex items-center gap-3 px-4 py-3 border-t border-th first:border-t-0"
            >
              <span className="text-th-muted font-mono text-sm w-6 text-right">{idx + 1}</span>
              <div className="flex-1 flex items-center gap-3">
                <span className="text-th-primary font-medium">{player.name}</span>
                <RoleBadge role={player.role} />
                {player.isInternational && (
                  <span className="text-blue-400 text-[10px] bg-blue-400/10 px-1.5 py-0.5 rounded">OS</span>
                )}
                {player.isWicketKeeper && (
                  <span className="text-cyan-400 text-[10px] bg-cyan-400/10 px-1.5 py-0.5 rounded">WK</span>
                )}
              </div>
              <span className="text-th-faint text-xs w-24 text-right">{posLabel}</span>
              <span className={`${ovrColor(player.battingOvr)} font-bold text-sm w-8 text-right`}>
                {player.battingOvr}
              </span>
              <div className="flex flex-col gap-0.5 ml-2">
                <button
                  onClick={() => onMove(idx, -1)}
                  disabled={idx === 0}
                  aria-label="Move player up"
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    idx === 0 ? "text-th-faint" : "text-th-secondary hover:text-th-primary hover:bg-th-hover"
                  }`}
                >
                  ▲
                </button>
                <button
                  onClick={() => onMove(idx, 1)}
                  disabled={idx === battingOrder.length - 1}
                  aria-label="Move player down"
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    idx === battingOrder.length - 1 ? "text-th-faint" : "text-th-secondary hover:text-th-primary hover:bg-th-hover"
                  }`}
                >
                  ▼
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BowlingOrderTab({
  bowlingOrder,
  findPlayer,
  selectedIds,
  team,
  onMove,
  onAutoGenerate,
}: {
  bowlingOrder: string[];
  findPlayer: (id: string) => Player | undefined;
  selectedIds: Set<string>;
  team: Team;
  onMove: (idx: number, dir: -1 | 1) => void;
  onAutoGenerate: () => void;
}) {
  if (bowlingOrder.length === 0) {
    return (
      <div className="text-th-muted text-center py-12">
        Select your playing XI first to set bowling order
      </div>
    );
  }

  // Generate a simple 20-over plan
  const overPlan = useMemo(() => {
    if (bowlingOrder.length === 0) return [];
    const plan: string[] = [];
    const bowlerOversUsed = new Map<string, number>();
    for (const id of bowlingOrder) bowlerOversUsed.set(id, 0);

    for (let over = 0; over < 20; over++) {
      const lastBowler = plan.length > 0 ? plan[plan.length - 1] : null;
      const eligible = bowlingOrder.filter(id =>
        (bowlerOversUsed.get(id) ?? 0) < 4 && id !== lastBowler
      );
      if (eligible.length === 0) {
        // Fallback: allow consecutive
        const anyEligible = bowlingOrder.filter(id => (bowlerOversUsed.get(id) ?? 0) < 4);
        if (anyEligible.length > 0) {
          plan.push(anyEligible[0]);
          bowlerOversUsed.set(anyEligible[0], (bowlerOversUsed.get(anyEligible[0]) ?? 0) + 1);
        }
      } else {
        // Distribute: pick the bowler with fewest overs used so far
        eligible.sort((a, b) => (bowlerOversUsed.get(a) ?? 0) - (bowlerOversUsed.get(b) ?? 0));
        plan.push(eligible[0]);
        bowlerOversUsed.set(eligible[0], (bowlerOversUsed.get(eligible[0]) ?? 0) + 1);
      }
    }
    return plan;
  }, [bowlingOrder]);

  // Count overs per bowler
  const oversPerBowler = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of overPlan) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [overPlan]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">
          Bowling Plan ({bowlingOrder.length} bowlers)
        </h3>
        <button
          onClick={onAutoGenerate}
          className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs rounded-md transition-colors"
        >
          Auto Generate
        </button>
      </div>

      {/* Bowler list with priority */}
      <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-6">
        <div className="px-4 py-2 bg-th-raised border-b border-th">
          <span className="text-th-muted text-xs uppercase">Bowling Priority (higher = bowls earlier)</span>
        </div>
        {bowlingOrder.map((id, idx) => {
          const player = findPlayer(id);
          if (!player) return null;
          const overs = oversPerBowler.get(id) ?? 0;
          return (
            <div
              key={id}
              className="flex items-center gap-3 px-4 py-3 border-t border-th first:border-t-0"
            >
              <span className="text-th-muted font-mono text-sm w-6 text-right">{idx + 1}</span>
              <div className="flex-1 flex items-center gap-3">
                <span className="text-th-primary font-medium">{player.name}</span>
                <RoleBadge role={player.role} />
              </div>
              <span className={`${ovrColor(player.bowlingOvr)} font-bold text-sm w-8 text-right`}>
                {player.bowlingOvr}
              </span>
              <span className="text-th-secondary text-xs w-16 text-right">{overs}/4 overs</span>
              <div className="flex flex-col gap-0.5 ml-2">
                <button
                  onClick={() => onMove(idx, -1)}
                  disabled={idx === 0}
                  aria-label="Move player up"
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    idx === 0 ? "text-th-faint" : "text-th-secondary hover:text-th-primary hover:bg-th-hover"
                  }`}
                >
                  ▲
                </button>
                <button
                  onClick={() => onMove(idx, 1)}
                  disabled={idx === bowlingOrder.length - 1}
                  aria-label="Move player down"
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    idx === bowlingOrder.length - 1 ? "text-th-faint" : "text-th-secondary hover:text-th-primary hover:bg-th-hover"
                  }`}
                >
                  ▼
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 20-over visual plan */}
      <div>
        <h4 className="text-th-secondary text-xs uppercase tracking-wider mb-2">Over-by-Over Plan</h4>
        <div className="grid grid-cols-10 gap-1.5">
          {overPlan.map((bowlerId, overIdx) => {
            const player = findPlayer(bowlerId);
            const phase = overIdx < 6 ? "PP" : overIdx < 15 ? "MID" : "DTH";
            const phaseColor = overIdx < 6 ? "border-blue-600/40" : overIdx < 15 ? "border-th" : "border-orange-600/40";
            return (
              <div key={overIdx} className={`bg-th-raised rounded p-1.5 text-center border ${phaseColor}`}>
                <div className="text-th-faint text-[10px]">Ov {overIdx + 1}</div>
                <div className="text-th-primary text-xs font-medium truncate">
                  {player?.name.split(" ").pop() ?? "?"}
                </div>
                <div className="text-th-faint text-[9px]">{phase}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- Utility components ----

function RoleBadge({ role }: { role: string }) {
  const label = roleLabel(role);
  const color = roleColor(role);
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${color}`}>
      {label}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    minor: "bg-yellow-900/30 text-yellow-400",
    moderate: "bg-orange-900/30 text-orange-400",
    severe: "bg-red-900/30 text-red-300",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${colors[severity] ?? colors.minor}`}>
      {severity}
    </span>
  );
}

function ovrColor(ovr: number): string {
  if (ovr >= 85) return "text-green-400";
  if (ovr >= 70) return "text-blue-400";
  if (ovr >= 55) return "text-yellow-400";
  return "text-th-secondary";
}

function roleLabel(role: string): string {
  switch (role) {
    case "batsman": return "BAT";
    case "bowler": return "BWL";
    case "all-rounder": return "AR";
    case "wicket-keeper": return "WK";
    default: return role;
  }
}

function roleColor(role: string): string {
  switch (role) {
    case "batsman": return "bg-orange-900/30 text-orange-400";
    case "bowler": return "bg-purple-900/30 text-purple-400";
    case "all-rounder": return "bg-green-900/30 text-green-400";
    case "wicket-keeper": return "bg-cyan-900/30 text-cyan-400";
    default: return "bg-th-raised text-th-secondary";
  }
}
