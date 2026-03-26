import React, { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Team, Player, type BowlingPlan, type RuleSet } from "@ipl-sim/engine";
import { bowlingStyleLabel } from "../ui-utils";
import {
  buildLineupReport,
  getBattingSlotFit,
  getBestBowlingPhaseFit,
  getBowlingPhaseFit,
  type FitAssessment,
  type LineupReport,
} from "../lineup-advisor";

interface Props {
  team: Team;
  rules: RuleSet;
  onConfirm: (xi: string[], battingOrder: string[], bowlingOrder: string[], bowlingPlan?: BowlingPlan) => void;
}

export function LineupPage({ team, rules, onConfirm }: Props) {
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
    const autoXI = team.autoSelectPlayingXI(rules.maxOverseasInXI);
    return new Set(autoXI.map(p => p.id));
  });

  const [battingOrder, setBattingOrder] = useState<string[]>(() => {
    if (team.userBattingOrder && team.userBattingOrder.length > 0) {
      return team.userBattingOrder.filter(id => selectedIds.has(id));
    }
    const xi = team.autoSelectPlayingXI(rules.maxOverseasInXI);
    return team.autoBattingOrder(xi).map(p => p.id);
  });

  const [bowlingOrder, setBowlingOrder] = useState<string[]>(() => {
    if (team.userBowlingOrder && team.userBowlingOrder.length > 0) {
      return team.userBowlingOrder.filter(id => selectedIds.has(id));
    }
    const xi = team.autoSelectPlayingXI(rules.maxOverseasInXI);
    return team.autoBowlingOrder(xi).map(p => p.id);
  });

  const [activeTab, setActiveTab] = useState<"xi" | "batting" | "bowling" | "bowlingPlan">("xi");

  // Bowling plan state: phase-specific bowler assignments
  const [bowlingPlanState, setBowlingPlanState] = useState<BowlingPlan>(() => {
    const existing = team.getBowlingPlan();
    if (existing) return existing;
    return { powerplay: [], middle: [], death: [] };
  });

  // Per-batter aggression presets (0-100, 50=normal)
  const [batterAggression, setBatterAggression] = useState<Record<string, number>>(
    () => team.batterAggression ?? {}
  );
  // Per-bowler default field settings
  type FieldSettingType = "aggressive" | "standard" | "defensive" | "spin-attack" | "boundary-save";
  const [bowlerFieldSettings, setBowlerFieldSettings] = useState<Record<string, FieldSettingType>>(
    () => (team.bowlerFieldSettings ?? {}) as Record<string, FieldSettingType>
  );

  // Derive selected players
  const selectedPlayers = useMemo(
    () => Array.from(selectedIds).map(id => team.roster.find(p => p.id === id)!).filter(Boolean),
    [selectedIds, team]
  );
  const battingOrderPlayers = useMemo(
    () => battingOrder.filter(id => selectedIds.has(id)).map(id => team.roster.find(p => p.id === id)!).filter(Boolean),
    [battingOrder, selectedIds, team]
  );
  const bowlingOrderPlayers = useMemo(
    () => bowlingOrder.filter(id => selectedIds.has(id)).map(id => team.roster.find(p => p.id === id)!).filter(Boolean),
    [bowlingOrder, selectedIds, team]
  );

  const overseasCount = selectedPlayers.filter(p => p.isInternational).length;
  const wkCount = selectedPlayers.filter(p => p.isWicketKeeper).length;
  const bowlerCount = selectedPlayers.filter(p => p.role === "bowler" || p.role === "all-rounder").length;

  // Validation
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (selectedIds.size !== 11) errors.push(`Select exactly 11 players (${selectedIds.size}/11)`);
    if (overseasCount > rules.maxOverseasInXI) errors.push(`Max ${rules.maxOverseasInXI} overseas players (${overseasCount}/${rules.maxOverseasInXI})`);
    if (wkCount < 1) errors.push("Need at least 1 wicket-keeper");
    return errors;
  }, [selectedIds.size, overseasCount, wkCount]);

  const isValid = validationErrors.length === 0;

  const lineupReport = useMemo(() => buildLineupReport({
    team,
    availablePlayers: available,
    selectedPlayers,
    battingOrder: battingOrderPlayers,
    bowlingOrder: bowlingOrderPlayers,
    bowlingPlan: bowlingPlanState,
  }), [team, available, selectedPlayers, battingOrderPlayers, bowlingOrderPlayers, bowlingPlanState]);

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
    // Update bowling order: bowlers/ARs + any batsman with decent bowling (ovr >= 30)
    setBowlingOrder(prev => {
      const xiPlayers = Array.from(newIds).map(id => team.roster.find(r => r.id === id)).filter(Boolean) as Player[];
      const bowlerIds = xiPlayers
        .filter(p => p.role === "bowler" || p.role === "all-rounder")
        .map(p => p.id);
      const kept = prev.filter(id => newIds.has(id) && bowlerIds.includes(id));
      const added = bowlerIds.filter(id => !kept.includes(id));
      const result = [...kept, ...added];
      // Add part-timers: pad to 5 minimum, also include any batsman with bowlingOvr >= 30
      const partTimers = xiPlayers
        .filter(p => p.role === "batsman" && !result.includes(p.id))
        .sort((a, b) => b.bowlingOvr - a.bowlingOvr);
      for (const pt of partTimers) {
        if (result.length < 5 || pt.bowlingOvr >= 30) {
          result.push(pt.id);
        }
      }
      return result;
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
    const autoXI = team.autoSelectPlayingXI(rules.maxOverseasInXI);
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

    // Save per-player presets to the team
    const activeAggr: Record<string, number> = {};
    for (const [id, val] of Object.entries(batterAggression)) {
      if (selectedIds.has(id) && val !== 50) activeAggr[id] = val;
    }
    team.batterAggression = Object.keys(activeAggr).length > 0 ? activeAggr : undefined;
    const activeFields: Record<string, FieldSettingType> = {};
    for (const [id, val] of Object.entries(bowlerFieldSettings)) {
      if (selectedIds.has(id) && val !== "standard") activeFields[id] = val;
    }
    team.bowlerFieldSettings = Object.keys(activeFields).length > 0 ? activeFields : undefined;

    // Pass bowling plan only if any phase has bowlers assigned
    const hasPlan = bowlingPlanState.powerplay.length > 0 || bowlingPlanState.middle.length > 0 || bowlingPlanState.death.length > 0;
    onConfirm(xiIds, fullBatting, finalBowling, hasPlan ? bowlingPlanState : undefined);
  }, [selectedIds, battingOrder, bowlingOrder, bowlingPlanState, batterAggression, bowlerFieldSettings, team, onConfirm]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-th-primary">Lineup Management</h2>
          <p className="text-th-secondary mt-1">
            Set your playing XI, batting order, and bowling plan for{" "}
            <span style={{ color: team.config.primaryColor }} className="font-semibold">{team.name}</span>
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
          <button
            onClick={() => {
              // Auto-select best XI and immediately confirm
              const autoXI = team.autoSelectPlayingXI(rules.maxOverseasInXI);
              const autoIds = autoXI.map(p => p.id);
              const autoBat = team.autoBattingOrder(autoXI).map(p => p.id);
              const autoBowl = team.autoBowlingOrder(autoXI).map(p => p.id);
              onConfirm(autoIds, autoBat, autoBowl);
            }}
            className="w-full rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-display font-semibold text-white transition-all hover:from-orange-400 hover:to-amber-400 sm:w-auto"
          >
            Quick Start
          </button>
          <button
            onClick={() => navigate("/season")}
            className="w-full text-sm text-th-secondary hover:text-th-primary sm:w-auto"
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
      <div className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-th-surface p-1 sm:inline-grid sm:w-fit sm:grid-cols-4">
        {(["xi", "batting", "bowling", "bowlingPlan"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors sm:px-4 ${
              activeTab === tab
                ? "bg-blue-600 text-white"
                : "text-th-secondary hover:text-th-primary hover:bg-th-hover"
            }`}
          >
            {tab === "xi" ? "Playing XI" : tab === "batting" ? "Batting Order" : tab === "bowling" ? "Bowling Order" : "Bowling Plan"}
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
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm sm:gap-6">
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

      <SelectionReport report={lineupReport} />

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
          battingOrder={battingOrderPlayers}
          onMove={(idx, dir) => moveInOrder(
            battingOrder.filter(id => selectedIds.has(id)),
            (newOrder) => setBattingOrder(newOrder),
            idx,
            dir
          )}
          onAutoSort={handleAutoSortBatting}
          batterAggression={batterAggression}
          onSetAggression={(id, val) => setBatterAggression(prev => ({ ...prev, [id]: val }))}
        />
      )}

      {activeTab === "bowling" && (
        <BowlingOrderTab
          bowlingOrder={bowlingOrderPlayers}
          availableToAdd={selectedPlayers.filter(p => !bowlingOrder.includes(p.id))}
          onMove={(idx, dir) => moveInOrder(
            bowlingOrder.filter(id => selectedIds.has(id)),
            (newOrder) => setBowlingOrder(newOrder),
            idx,
            dir
          )}
          onAddBowler={(id) => setBowlingOrder(prev => [...prev, id])}
          onRemoveBowler={(id) => setBowlingOrder(prev => prev.filter(pid => pid !== id))}
          onAutoGenerate={handleAutoSortBowling}
          bowlerFieldSettings={bowlerFieldSettings}
          onSetFieldSetting={(id, val) => setBowlerFieldSettings(prev => ({ ...prev, [id]: val as FieldSettingType }))}
        />
      )}

      {activeTab === "bowlingPlan" && (
        <BowlingPlanTab
          bowlingOrder={bowlingOrderPlayers}
          bowlingPlan={bowlingPlanState}
          onUpdatePlan={setBowlingPlanState}
        />
      )}

      {/* Confirm button */}
      <div className="mt-8 flex justify-stretch sm:justify-end">
        <button
          onClick={handleConfirm}
          disabled={!isValid}
          className={`w-full rounded-lg px-8 py-3 text-lg font-semibold transition-colors sm:w-auto ${
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
  const navigate = useNavigate();
  const sorted = useMemo(
    () => [...available].sort((a, b) => b.selectionScore - a.selectionScore || b.overall - a.overall),
    [available]
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">Squad</h3>
        <button
          onClick={onAutoSelect}
          className="w-full rounded-md bg-th-raised px-3 py-1.5 text-xs text-th-secondary transition-colors hover:bg-th-hover sm:w-auto"
        >
          Auto Select
        </button>
      </div>

      <div className="bg-th-surface rounded-xl border border-th overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
            <tr className="text-th-muted text-xs uppercase bg-th-raised">
              <th className="w-10 px-3 py-2"></th>
              <th className="text-left px-3 py-2">Player</th>
              <th className="text-center px-2 py-2">Role</th>
              <th className="text-center px-2 py-2">OVR</th>
              <th className="hidden md:table-cell text-center px-2 py-2">BAT</th>
              <th className="hidden md:table-cell text-center px-2 py-2">BWL</th>
              <th className="hidden sm:table-cell text-center px-2 py-2">Age</th>
              <th className="hidden sm:table-cell text-center px-2 py-2">Ready</th>
              <th className="hidden lg:table-cell text-center px-2 py-2">Status</th>
            </tr>
            </thead>
            <tbody>
            {sorted.map(p => {
              const isSelected = selectedIds.has(p.id);
              const isExpanded = expandedId === p.id;
              return (
                <React.Fragment key={p.id}>
                <tr
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
                      <span
                        className="text-th-primary font-medium cursor-pointer hover:text-orange-400 transition-colors"
                        onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : p.id); }}
                        onDoubleClick={(e) => { e.stopPropagation(); navigate(`/player/${p.id}`); }}
                        title="Click to expand stats, double-click for full profile"
                      >{p.name}</span>
                      <FormIndicator player={p} />
                      <ConditionBadge player={p} />
                      <span className={`w-2 h-2 rounded-full inline-block ${
                        p.morale > 70 ? "bg-emerald-400" : p.morale > 40 ? "bg-amber-400" : "bg-red-400"
                      }`} title={`Morale: ${p.morale}`} />
                      {p.contractYears <= 0 && (
                        <span className="text-[9px] px-1 rounded text-red-400 bg-red-500/10">FA</span>
                      )}
                      {p.isInternational && (
                        <span className="text-blue-400 text-[10px] bg-blue-400/10 px-1.5 py-0.5 rounded">OS</span>
                      )}
                      {p.isWicketKeeper && (
                        <span className="text-cyan-400 text-[10px] bg-cyan-400/10 px-1.5 py-0.5 rounded">WK</span>
                      )}
                      {p.bowlingStyle && bowlingStyleLabel(p.bowlingStyle) && (
                        <span className="text-purple-400/60 text-[10px] font-semibold">{bowlingStyleLabel(p.bowlingStyle)}</span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : p.id); }}
                        className="text-th-faint hover:text-th-secondary text-[10px] ml-1"
                        title="Show ratings"
                      >
                        {isExpanded ? "▾" : "▸"} stats
                      </button>
                    </div>
                    <span className="text-th-faint text-xs">{p.country}</span>
                  </td>
                  <td className="text-center px-2 py-2">
                    <RoleBadge role={p.role} />
                  </td>
                  <td className="text-center px-2 py-2">
                    <span className={`font-bold ${ovrColor(p.overall)}`}>{p.overall}</span>
                  </td>
                  <td className="hidden md:table-cell text-center px-2 py-2 text-th-secondary">{p.battingOvr}</td>
                  <td className="hidden md:table-cell text-center px-2 py-2 text-th-secondary">{p.bowlingOvr}</td>
                  <td className="hidden sm:table-cell text-center px-2 py-2 text-th-muted">{p.age}</td>
                  <td className={`hidden sm:table-cell text-center px-2 py-2 text-xs ${conditionTextColor(p.readiness)}`}>{p.readiness}</td>
                  <td className={`hidden lg:table-cell text-center px-2 py-2 text-xs ${conditionTextColor(p.readiness)}`}>{conditionLabel(p.readiness)}</td>
                </tr>
                {isExpanded && (
                  <tr className="border-t border-th/50">
                    <td colSpan={9} className="px-4 py-3 bg-th-raised/50">
                      <PlayerRatingBars player={p} />
                    </td>
                  </tr>
                )}
                </React.Fragment>
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
                <td className="hidden md:table-cell text-center px-2 py-2 text-th-faint">{p.battingOvr}</td>
                <td className="hidden md:table-cell text-center px-2 py-2 text-th-faint">{p.bowlingOvr}</td>
                <td className="hidden sm:table-cell text-center px-2 py-2 text-th-faint">{p.age}</td>
                <td className="hidden sm:table-cell text-center px-2 py-2 text-th-faint text-xs">{p.readiness}</td>
                <td className="hidden lg:table-cell text-center px-2 py-2">
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
    </div>
  );
}

function BattingOrderTab({
  battingOrder,
  onMove,
  onAutoSort,
  batterAggression,
  onSetAggression,
}: {
  battingOrder: Player[];
  onMove: (idx: number, dir: -1 | 1) => void;
  onAutoSort: () => void;
  batterAggression: Record<string, number>;
  onSetAggression: (id: string, val: number) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (battingOrder.length === 0) {
    return (
      <div className="text-th-muted text-center py-12">
        Select your playing XI first to set batting order
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">
          Batting Order ({battingOrder.length} batters)
        </h3>
        <button
          onClick={onAutoSort}
          className="w-full rounded-md bg-th-raised px-3 py-1.5 text-xs text-th-secondary transition-colors hover:bg-th-hover sm:w-auto"
        >
          Auto Sort
        </button>
      </div>

      <div className="bg-th-surface rounded-xl border border-th overflow-hidden">
        {battingOrder.map((player, idx) => {
          const slotFit = getBattingSlotFit(player, idx);
          const fitTone = fitBadgeTone(slotFit);

          let posLabel = "";
          if (idx < 2) posLabel = "Opener";
          else if (idx < 5) posLabel = "Top Order";
          else if (idx < 8) posLabel = "Middle Order";
          else posLabel = "Lower Order";

          const isExpanded = expandedId === player.id;
          return (
            <React.Fragment key={player.id}>
            <div className="flex flex-wrap items-center gap-3 border-t border-th px-4 py-3 first:border-t-0">
              <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
                <span className="w-6 text-right font-mono text-sm text-th-muted">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <span className="text-th-primary font-medium">{player.name}</span>
                    <FormIndicator player={player} />
                    <ConditionBadge player={player} />
                    <RoleBadge role={player.role} />
                    {player.isInternational && (
                      <span className="text-blue-400 text-[10px] bg-blue-400/10 px-1.5 py-0.5 rounded">OS</span>
                    )}
                    {player.isWicketKeeper && (
                      <span className="text-cyan-400 text-[10px] bg-cyan-400/10 px-1.5 py-0.5 rounded">WK</span>
                    )}
                    {player.bowlingStyle && bowlingStyleLabel(player.bowlingStyle) && (
                      <span className="text-purple-400/60 text-[10px] font-semibold">{bowlingStyleLabel(player.bowlingStyle)}</span>
                    )}
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : player.id)}
                      className="text-th-faint hover:text-th-secondary text-[10px]"
                    >
                      {isExpanded ? "▾" : "▸"} stats
                    </button>
                  </div>
                </div>
              </div>
              <div className="w-full text-left sm:w-28 sm:text-right">
                <div className="text-th-faint text-xs">{posLabel}</div>
                <div className={`text-[10px] inline-flex mt-1 px-1.5 py-0.5 rounded ${fitTone}`}>{slotFit.label}</div>
              </div>
              <div className="flex flex-wrap gap-0.5">
                {([
                  { val: 25, label: "DEF", color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
                  { val: 50, label: "NOR", color: "text-th-secondary bg-th-body border-th" },
                  { val: 75, label: "ATK", color: "text-orange-400 bg-orange-500/10 border-orange-500/20" },
                ] as const).map(opt => {
                  const current = batterAggression[player.id] ?? 50;
                  const isActive = Math.abs(current - opt.val) < 13;
                  return (
                    <button
                      key={opt.val}
                      onClick={(e) => { e.stopPropagation(); onSetAggression(player.id, opt.val); }}
                      className={`text-[9px] px-1.5 py-0.5 rounded border font-display font-semibold transition-colors ${isActive ? opt.color + " ring-1 ring-offset-0" : "text-th-faint bg-th-body border-th/50 hover:text-th-secondary"}`}
                    >{opt.label}</button>
                  );
                })}
              </div>
              <span className={`${ovrColor(player.battingOvr)} ml-auto font-bold text-sm w-8 text-right`}>
                {player.battingOvr}
              </span>
              <div className="ml-2 flex flex-row gap-0.5 sm:flex-col">
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
            {isExpanded && (
              <div className="px-4 py-3 bg-th-raised/50 border-t border-th/50">
                <PlayerRatingBars player={player} />
              </div>
            )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function BowlingOrderTab({
  bowlingOrder,
  availableToAdd,
  onMove,
  onAddBowler,
  onRemoveBowler,
  onAutoGenerate,
  bowlerFieldSettings,
  onSetFieldSetting,
}: {
  bowlingOrder: Player[];
  availableToAdd: Player[];
  onMove: (idx: number, dir: -1 | 1) => void;
  onAddBowler: (id: string) => void;
  onRemoveBowler: (id: string) => void;
  onAutoGenerate: () => void;
  bowlerFieldSettings: Record<string, string>;
  onSetFieldSetting: (id: string, val: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (bowlingOrder.length === 0) {
    return (
      <div className="text-th-muted text-center py-12">
        Select your playing XI first to set bowling order
      </div>
    );
  }

  const bowlingById = useMemo(
    () => new Map(bowlingOrder.map(player => [player.id, player])),
    [bowlingOrder],
  );

  // Generate auto plan helper
  const generateAutoPlan = useCallback(() => {
    if (bowlingOrder.length === 0) return [];
    const plan: string[] = [];
    const bowlerOversUsed = new Map<string, number>();
    for (const player of bowlingOrder) bowlerOversUsed.set(player.id, 0);

    for (let over = 0; over < 20; over++) {
      const lastBowler = plan.length > 0 ? plan[plan.length - 1] : null;
      const eligible = bowlingOrder.filter(player =>
        (bowlerOversUsed.get(player.id) ?? 0) < 4 && player.id !== lastBowler
      );
      if (eligible.length === 0) {
        const anyEligible = bowlingOrder.filter(player => (bowlerOversUsed.get(player.id) ?? 0) < 4);
        if (anyEligible.length > 0) {
          plan.push(anyEligible[0].id);
          bowlerOversUsed.set(anyEligible[0].id, (bowlerOversUsed.get(anyEligible[0].id) ?? 0) + 1);
        }
      } else {
        eligible.sort((a, b) => (bowlerOversUsed.get(a.id) ?? 0) - (bowlerOversUsed.get(b.id) ?? 0));
        plan.push(eligible[0].id);
        bowlerOversUsed.set(eligible[0].id, (bowlerOversUsed.get(eligible[0].id) ?? 0) + 1);
      }
    }
    return plan;
  }, [bowlingOrder]);

  const [overPlan, setOverPlan] = useState<string[]>(() => generateAutoPlan());

  // Cycle bowler for a specific over
  const cycleBowlerForOver = useCallback((overIdx: number) => {
    setOverPlan(prev => {
      const next = [...prev];
      const currentId = next[overIdx];
      // Count overs for each bowler excluding this slot
      const counts = new Map<string, number>();
      for (const p of bowlingOrder) counts.set(p.id, 0);
      next.forEach((id, i) => { if (i !== overIdx) counts.set(id, (counts.get(id) ?? 0) + 1); });
      // Find bowlers who can still bowl (< 4 overs) and are not same as adjacent overs
      const prevBowler = overIdx > 0 ? next[overIdx - 1] : null;
      const nextBowler = overIdx < 19 ? next[overIdx + 1] : null;
      const eligible = bowlingOrder.filter(p =>
        (counts.get(p.id) ?? 0) < 4 && p.id !== prevBowler && p.id !== nextBowler
      );
      if (eligible.length === 0) return prev;
      // Cycle to next eligible bowler after current
      const currentIdx = eligible.findIndex(p => p.id === currentId);
      const nextPlayer = eligible[(currentIdx + 1) % eligible.length];
      next[overIdx] = nextPlayer.id;
      return next;
    });
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
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">
          Bowling Plan ({bowlingOrder.length} bowlers)
        </h3>
        <button
          onClick={onAutoGenerate}
          className="w-full rounded-md bg-th-raised px-3 py-1.5 text-xs text-th-secondary transition-colors hover:bg-th-hover sm:w-auto"
        >
          Auto Generate
        </button>
      </div>

      {/* Bowler list with priority */}
      <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-6">
        <div className="px-4 py-2 bg-th-raised border-b border-th">
          <span className="text-th-muted text-xs uppercase">Bowling Priority (higher = bowls earlier)</span>
        </div>
        {bowlingOrder.map((player, idx) => {
          const overs = oversPerBowler.get(player.id) ?? 0;
          const bestPhase = getBestBowlingPhaseFit(player);
          const bestPhaseLabel = bestPhase.phase === "powerplay" ? "PP" : bestPhase.phase === "middle" ? "MID" : "DTH";
          const isExpanded = expandedId === player.id;
          return (
            <React.Fragment key={player.id}>
            <div className="flex flex-wrap items-center gap-3 border-t border-th px-4 py-3 first:border-t-0">
              <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
                <span className="w-6 text-right font-mono text-sm text-th-muted">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <span
                      className="text-th-primary font-medium cursor-pointer hover:text-orange-400 transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : player.id)}
                      title="Click to view ratings"
                    >{player.name}</span>
                    <FormIndicator player={player} />
                    <ConditionBadge player={player} />
                    <RoleBadge role={player.role} />
                    {player.bowlingStyle && bowlingStyleLabel(player.bowlingStyle) && (
                      <span className="text-purple-400/60 text-[10px] font-semibold">{bowlingStyleLabel(player.bowlingStyle)}</span>
                    )}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${fitBadgeTone(bestPhase)}`}>
                      Best {bestPhaseLabel}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-0.5">
                {([
                  { val: "aggressive", label: "AGR", color: "text-red-400 bg-red-500/10 border-red-500/20" },
                  { val: "standard", label: "STD", color: "text-th-secondary bg-th-body border-th" },
                  { val: "defensive", label: "DEF", color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
                  { val: "spin-attack", label: "SPN", color: "text-purple-400 bg-purple-500/10 border-purple-500/20" },
                ] as const).map(opt => {
                  const current = bowlerFieldSettings[player.id] ?? "standard";
                  const isActive = current === opt.val;
                  return (
                    <button
                      key={opt.val}
                      onClick={(e) => { e.stopPropagation(); onSetFieldSetting(player.id, opt.val); }}
                      className={`text-[9px] px-1 py-0.5 rounded border font-display font-semibold transition-colors ${isActive ? opt.color + " ring-1 ring-offset-0" : "text-th-faint bg-th-body border-th/50 hover:text-th-secondary"}`}
                    >{opt.label}</button>
                  );
                })}
              </div>
              <span className={`${ovrColor(player.bowlingOvr)} ml-auto font-bold text-sm w-8 text-right`}>
                {player.bowlingOvr}
              </span>
              <span className="text-th-secondary text-xs w-16 text-right">{overs}/4 overs</span>
              <div className="ml-2 flex flex-row gap-0.5 sm:flex-col">
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
              {bowlingOrder.length > 5 && (
                <button
                  onClick={() => onRemoveBowler(player.id)}
                  className="text-red-400/60 hover:text-red-400 text-xs ml-1"
                  title="Remove from bowling order"
                >
                  ✕
                </button>
              )}
            </div>
            {isExpanded && (
              <div className="px-4 py-3 bg-th-raised/50 border-t border-th/50">
                <PlayerRatingBars player={player} />
              </div>
            )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Add bowler from XI */}
      {availableToAdd.length > 0 && (
        <div className="mb-6">
          <div className="text-[10px] text-th-muted uppercase tracking-wider font-display mb-2">Add Bowling Option</div>
          <div className="flex flex-wrap gap-1.5">
            {availableToAdd
              .sort((a, b) => b.bowlingOvr - a.bowlingOvr)
              .map(p => (
                <button
                  key={p.id}
                  onClick={() => onAddBowler(p.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-th bg-th-surface hover:bg-th-hover hover:border-th-strong text-xs transition-all"
                >
                  <span className="text-th-primary font-medium">{p.name}</span>
                  <span className="text-th-faint font-mono">{p.bowlingOvr}</span>
                  {p.bowlingStyle && bowlingStyleLabel(p.bowlingStyle) && (
                    <span className="text-purple-400/60 text-[9px] font-semibold">{bowlingStyleLabel(p.bowlingStyle)}</span>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* 20-over visual plan — click to cycle bowler */}
      <div>
        <h4 className="text-th-secondary text-xs uppercase tracking-wider mb-2">
          Over-by-Over Plan <span className="text-th-faint font-normal">(click to change)</span>
        </h4>
        <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
          {overPlan.map((bowlerId, overIdx) => {
            const player = bowlingById.get(bowlerId);
            const phase = overIdx < 6 ? "PP" : overIdx < 15 ? "MID" : "DTH";
            const phaseColor = overIdx < 6 ? "border-blue-600/40" : overIdx < 15 ? "border-th" : "border-orange-600/40";
            return (
              <button
                key={overIdx}
                onClick={() => cycleBowlerForOver(overIdx)}
                className={`bg-th-raised rounded p-1.5 text-center border ${phaseColor} hover:bg-th-hover hover:border-orange-500/30 transition-colors cursor-pointer`}
              >
                <div className="text-th-faint text-[10px]">Ov {overIdx + 1}</div>
                <div className="text-th-primary text-xs font-medium truncate">
                  {player?.name.split(" ").pop() ?? "?"}
                </div>
                <div className="text-th-faint text-[9px]">{phase}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SelectionReport({ report }: { report: LineupReport }) {
  return (
    <div className="rounded-2xl border border-th bg-th-surface p-4 mb-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-4">
        <div>
          <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">Assistant Report</h3>
          <p className="text-th-muted text-xs mt-1">
            Coach-style feedback from current form, batting slots, bowling phases, and the home venue.
          </p>
        </div>
        <div className="text-th-faint text-xs">{report.venueLabel}</div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <MetricCard label="Lineup Score" value={String(report.lineupScore)} accent="text-blue-400" />
        <MetricCard label="Avg Readiness" value={String(report.averageReadiness)} accent="text-cyan-400" />
        <MetricCard label="Hot Starters" value={String(report.hotStarters)} accent="text-green-400" />
        <MetricCard label="Tired XI" value={String(report.tiredStarters)} accent="text-amber-400" />
        <MetricCard label="Bowling Options" value={String(report.bowlingOptions)} accent="text-purple-400" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <InsightList title="Strengths" tone="good" insights={report.strengths} empty="No major strengths stand out yet." />
        <InsightList title="Concerns" tone="warn" insights={report.concerns} empty="No major concerns flagged." />
        <InsightList title="Next Calls" tone="info" insights={report.recommendations} empty="The current setup does not have an obvious forced move." />
      </div>
    </div>
  );
}

function InsightList({
  title,
  tone,
  insights,
  empty,
}: {
  title: string;
  tone: "good" | "info" | "warn";
  insights: { title: string; detail: string }[];
  empty: string;
}) {
  const toneClasses = tone === "good"
    ? "border-green-900/40 bg-green-950/10"
    : tone === "warn"
      ? "border-red-900/40 bg-red-950/10"
      : "border-blue-900/40 bg-blue-950/10";

  return (
    <div className={`rounded-xl border ${toneClasses} p-3`}>
      <h4 className="text-th-primary text-xs font-semibold uppercase tracking-wider mb-2">{title}</h4>
      {insights.length === 0 ? (
        <p className="text-th-faint text-xs">{empty}</p>
      ) : (
        <div className="space-y-2">
          {insights.map((insight, index) => (
            <div key={`${title}-${index}`}>
              <div className="text-th-primary text-sm font-medium">{insight.title}</div>
              <div className="text-th-muted text-xs mt-0.5">{insight.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl border border-th bg-th-raised px-3 py-2.5">
      <div className="text-th-faint text-[10px] uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-semibold mt-1 ${accent}`}>{value}</div>
    </div>
  );
}

// ---- Utility components ----

function PlayerRatingBars({ player }: { player: Player }) {
  const attrs = [
    { key: "battingIQ", label: "IQ", color: "bg-orange-400" },
    { key: "timing", label: "TIM", color: "bg-amber-400" },
    { key: "power", label: "PWR", color: "bg-red-400" },
    { key: "running", label: "RUN", color: "bg-emerald-400" },
    { key: "wicketTaking", label: "WKT", color: "bg-purple-400" },
    { key: "economy", label: "ECO", color: "bg-blue-400" },
    { key: "accuracy", label: "ACC", color: "bg-cyan-400" },
    { key: "clutch", label: "CLT", color: "bg-pink-400" },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 xl:grid-cols-8">
      {attrs.map(({ key, label, color }) => {
        const val = player.ratings[key];
        return (
          <div key={key} className="flex flex-col gap-0.5">
            <div className="flex justify-between text-[10px]">
              <span className="text-th-muted">{label}</span>
              <span className="text-th-primary font-mono font-semibold">{val}</span>
            </div>
            <div className="h-1.5 bg-th-overlay rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${val}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

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
    default: return role;
  }
}

function roleColor(role: string): string {
  switch (role) {
    case "batsman": return "bg-orange-900/30 text-orange-400";
    case "bowler": return "bg-purple-900/30 text-purple-400";
    case "all-rounder": return "bg-green-900/30 text-green-400";
    default: return "bg-th-raised text-th-secondary";
  }
}

function fitBadgeTone(fit: FitAssessment): string {
  if (fit.tone === "good") return "bg-green-900/30 text-green-300";
  if (fit.tone === "warn") return "bg-red-900/30 text-red-300";
  return "bg-blue-900/30 text-blue-300";
}

/** Form indicator: shows hot/cold form based on rolling average */
export function FormIndicator({ player }: { player: Player }) {
  const form = player.form;
  if (form > 65) {
    return <span className="text-green-400 text-xs ml-1" title={`Form: ${Math.round(form)}`}>&#9650;</span>;
  }
  if (form < 35) {
    return <span className="text-red-400 text-xs ml-1" title={`Form: ${Math.round(form)}`}>&#9660;</span>;
  }
  return null; // Neutral form: no indicator
}

function conditionLabel(readiness: number): string {
  if (readiness >= 85) return "Fresh";
  if (readiness >= 70) return "Good";
  if (readiness >= 55) return "Managed";
  if (readiness >= 40) return "Tired";
  return "Exhausted";
}

function conditionTextColor(readiness: number): string {
  if (readiness >= 85) return "text-cyan-300";
  if (readiness >= 70) return "text-green-300";
  if (readiness >= 55) return "text-yellow-300";
  if (readiness >= 40) return "text-orange-300";
  return "text-red-300";
}

function ConditionBadge({ player }: { player: Player }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${fitBadgeTone({
      score: player.readiness,
      tone: player.readiness >= 70 ? "good" : player.readiness >= 55 ? "info" : "warn",
      label: "",
    })}`}>
      {conditionLabel(player.readiness)}
    </span>
  );
}

function BowlingPlanTab({
  bowlingOrder,
  bowlingPlan,
  onUpdatePlan,
}: {
  bowlingOrder: Player[];
  bowlingPlan: BowlingPlan;
  onUpdatePlan: (plan: BowlingPlan) => void;
}) {
  const phases = [
    { key: "powerplay" as const, label: "Powerplay (Overs 1-6)", color: "border-blue-600/40", bgColor: "bg-blue-950/20" },
    { key: "middle" as const, label: "Middle Overs (7-15)", color: "border-green-600/40", bgColor: "bg-green-950/20" },
    { key: "death" as const, label: "Death Overs (16-20)", color: "border-orange-600/40", bgColor: "bg-orange-950/20" },
  ];

  const toggleBowlerInPhase = (phase: "powerplay" | "middle" | "death", playerId: string) => {
    const current = bowlingPlan[phase];
    const updated = current.includes(playerId)
      ? current.filter(id => id !== playerId)
      : current.length < 3 ? [...current, playerId] : current;
    onUpdatePlan({ ...bowlingPlan, [phase]: updated });
  };

  const autoAssign = () => {
    const paceIds: string[] = [];
    const spinIds: string[] = [];
    for (const player of bowlingOrder) {
      const style = player.bowlingStyle;
      if (["right-arm-fast", "right-arm-fast-medium", "right-arm-medium-fast", "right-arm-medium", "left-arm-fast", "left-arm-fast-medium", "left-arm-medium-fast", "left-arm-medium"].includes(style)) {
        paceIds.push(player.id);
      } else if (["off-spin", "left-arm-orthodox", "leg-spin", "left-arm-wrist-spin"].includes(style)) {
        spinIds.push(player.id);
      } else {
        paceIds.push(player.id);
      }
    }
    onUpdatePlan({
      powerplay: paceIds.slice(0, 3),
      middle: spinIds.length > 0 ? spinIds.slice(0, 3) : paceIds.slice(0, 2),
      death: paceIds.slice(0, 3),
    });
  };

  if (bowlingOrder.length === 0) {
    return (
      <div className="text-th-muted text-center py-12">
        Set your bowling order first to create a bowling plan
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-th-primary font-semibold text-sm uppercase tracking-wider">
          Phase-Specific Bowling Plan
        </h3>
        <button
          onClick={autoAssign}
          className="px-3 py-1.5 bg-th-raised hover:bg-th-hover text-th-secondary text-xs rounded-md transition-colors"
        >
          Auto Assign
        </button>
      </div>
      <p className="text-th-muted text-xs mb-4">
        Select 2-3 preferred bowlers for each phase. The engine will prioritize these bowlers during the corresponding overs.
      </p>

      <div className="space-y-6">
        {phases.map(({ key, label, color, bgColor }) => (
          <div key={key} className={`rounded-xl border ${color} ${bgColor} p-4`}>
            <h4 className="text-th-primary font-semibold text-sm mb-3">{label}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {bowlingOrder.map(player => {
                const phaseFit = getBowlingPhaseFit(player, key);
                const fitTone = fitBadgeTone(phaseFit);
                const isSelected = bowlingPlan[key].includes(player.id);
                return (
                  <button
                    key={player.id}
                    onClick={() => toggleBowlerInPhase(key, player.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors border ${
                      isSelected
                        ? "bg-blue-600/20 border-blue-500 text-white"
                        : "bg-th-surface border-th hover:bg-th-hover text-th-secondary"
                    }`}
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                      isSelected ? "bg-blue-600 border-blue-500 text-white" : "border-th-strong"
                    }`}>
                      {isSelected && "\u2713"}
                    </div>
                    <div className="flex-1 text-left">
                      <div className="font-medium text-xs">{player.name}</div>
                      <div className="text-[10px] text-th-muted flex flex-wrap items-center gap-1">
                        <span>{bowlingStyleLabel(player.bowlingStyle)} | BWL {player.bowlingOvr}</span>
                        <span className={`px-1.5 py-0.5 rounded ${fitTone}`}>{phaseFit.label}</span>
                      </div>
                    </div>
                    <FormIndicator player={player} />
                  </button>
                );
              })}
            </div>
            <div className="mt-2 text-th-faint text-[10px]">
              {bowlingPlan[key].length}/3 selected
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
