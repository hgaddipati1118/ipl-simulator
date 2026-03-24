import { useState } from "react";
import {
  Team, RULE_PRESETS, IPL_TEAMS, WPL_TEAMS, ALL_TEAM_IDS,
  type RuleSet, type PlayoffFormat, type GenderOption, type PlayerSource,
} from "@ipl-sim/engine";
import { TeamBadge } from "../components/TeamBadge";
import type { SaveSlotInfo } from "../game-state";

interface Props {
  teams: Team[];
  rules: RuleSet;
  onRulesChange: (rules: RuleSet) => void;
  onSelectTeam: (teamId: string) => void;
  slots?: SaveSlotInfo[];
  onLoadSlot?: (slotId: string) => void;
}

const ALL_TEAM_CONFIGS = [...IPL_TEAMS, ...WPL_TEAMS];

function CustomLeaguePanel({ rules, onRulesChange }: { rules: RuleSet; onRulesChange: (r: RuleSet) => void }) {
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set(rules.teamIds));
  const [leagueName, setLeagueName] = useState(rules.leagueName ?? "");
  const [matchesPerTeam, setMatchesPerTeam] = useState(rules.matchesPerTeam);
  const [playoffTeams, setPlayoffTeams] = useState(rules.playoffTeams);
  const [playoffFormat, setPlayoffFormat] = useState<PlayoffFormat>(rules.playoffFormat ?? "eliminator");
  const [impactPlayer, setImpactPlayer] = useState(rules.impactPlayer);
  const [salaryCap, setSalaryCap] = useState(rules.salaryCap);
  const [maxOverseasInXI, setMaxOverseasInXI] = useState(rules.maxOverseasInXI);
  const [injuriesEnabled, setInjuriesEnabled] = useState(rules.injuriesEnabled);
  const [gender, setGender] = useState<GenderOption>(rules.gender ?? "men");
  const [playerSource, setPlayerSource] = useState<PlayerSource>(rules.playerSource ?? "real");

  const toggleTeam = (id: string) => {
    const next = new Set(selectedTeams);
    next.has(id) ? next.delete(id) : next.add(id);
    if (next.size >= 2) setSelectedTeams(next);
  };

  const apply = () => {
    const teamIds = [...selectedTeams];
    const maxPlayoff = Math.min(playoffTeams, teamIds.length - 1);
    onRulesChange({
      name: leagueName || "Custom League",
      league: "custom",
      leagueName: leagueName || undefined,
      teamIds,
      impactPlayer,
      salaryCap,
      maxBouncersPerOver: 2,
      superOverTieBreaker: "repeated-super-over",
      maxOverseasInXI,
      maxOverseasInSquad: 8,
      maxSquadSize: 25,
      matchesPerTeam,
      playoffTeams: playoffFormat === "none" ? 0 : Math.max(maxPlayoff, 2),
      playoffFormat,
      scoringMultiplier: gender === "women" ? 0.82 : 1.0,
      injuriesEnabled,
      gender,
      playerSource,
    });
  };

  const sectionLabel = "text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2";
  const inputClass = "bg-th-surface border border-th rounded-lg px-3 py-2 text-sm text-th-primary font-mono focus:outline-none focus:border-orange-500/50";

  return (
    <div className="max-w-3xl mx-auto mb-8 rounded-2xl border border-th bg-th-surface p-5 sm:p-6 animate-fade-in space-y-5">
      {/* League Name */}
      <div>
        <div className={sectionLabel}>League Name</div>
        <input
          type="text"
          value={leagueName}
          onChange={e => setLeagueName(e.target.value)}
          placeholder="My League"
          className={`${inputClass} w-full sm:w-64`}
        />
      </div>

      {/* Gender + Player Source */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className={sectionLabel}>Players</div>
          <div className="flex flex-wrap gap-2">
            {(["men", "women", "combined"] as const).map(g => (
              <button
                key={g}
                onClick={() => setGender(g)}
                className={`px-3 py-1.5 rounded-lg text-xs font-display font-medium border transition-colors ${
                  gender === g
                    ? "bg-orange-500/20 border-orange-500/40 text-white"
                    : "bg-th-surface border-th text-th-muted hover:text-th-primary"
                }`}
              >
                {g === "men" ? "Men's" : g === "women" ? "Women's" : "Combined"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className={sectionLabel}>Player Source</div>
          <div className="flex gap-2">
            {(["real", "generated"] as const).map(s => (
              <button
                key={s}
                onClick={() => setPlayerSource(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-display font-medium border transition-colors ${
                  playerSource === s
                    ? "bg-orange-500/20 border-orange-500/40 text-white"
                    : "bg-th-surface border-th text-th-muted hover:text-th-primary"
                }`}
              >
                {s === "real" ? "Real Players" : "CPU Generated"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Team Selection */}
      <div>
        <div className={sectionLabel}>Teams ({selectedTeams.size} selected, min 2)</div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {ALL_TEAM_CONFIGS.map(config => {
            const selected = selectedTeams.has(config.id);
            return (
              <button
                key={config.id}
                onClick={() => toggleTeam(config.id)}
                className={`flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs font-display border transition-all ${
                  selected
                    ? "border-orange-500/40 bg-orange-500/10 text-white"
                    : "border-th bg-th-surface text-th-muted hover:text-th-primary opacity-50"
                }`}
              >
                <TeamBadge teamId={config.id} shortName={config.shortName} primaryColor={config.primaryColor} size="sm" />
                <span className="truncate">{config.shortName}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className={sectionLabel}>Matches per Team: {matchesPerTeam}</div>
          <input
            type="range"
            min="2"
            max="20"
            step="2"
            value={matchesPerTeam}
            onChange={e => setMatchesPerTeam(parseInt(e.target.value))}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-[10px] text-th-faint font-mono mt-1">
            <span>2</span>
            <span>{Math.floor(selectedTeams.size * matchesPerTeam / 2)} total matches</span>
            <span>20</span>
          </div>
        </div>
        <div>
          <div className={sectionLabel}>Salary Cap (Cr)</div>
          <input
            type="number"
            min="10"
            max="200"
            value={salaryCap}
            onChange={e => setSalaryCap(parseInt(e.target.value) || 120)}
            className={`${inputClass} w-24`}
          />
        </div>
      </div>

      {/* Playoff Format */}
      <div>
        <div className={sectionLabel}>Playoff Format</div>
        <div className="flex flex-wrap gap-2 mb-3">
          {([
            { value: "eliminator" as const, label: "Eliminator (IPL-style)", desc: "Top seeds get second chance" },
            { value: "simple" as const, label: "Simple Bracket", desc: "Straight knockout" },
            { value: "none" as const, label: "No Playoffs", desc: "League table decides" },
          ]).map(opt => (
            <button
              key={opt.value}
              onClick={() => {
                setPlayoffFormat(opt.value);
                if (opt.value === "none") setPlayoffTeams(0);
                else if (playoffTeams === 0) setPlayoffTeams(4);
              }}
              className={`px-3 py-2 rounded-lg text-xs font-display border transition-colors text-left ${
                playoffFormat === opt.value
                  ? "bg-orange-500/20 border-orange-500/40 text-white"
                  : "bg-th-surface border-th text-th-muted hover:text-th-primary"
              }`}
            >
              <div className="font-medium">{opt.label}</div>
              <div className="text-[10px] text-th-muted mt-0.5">{opt.desc}</div>
            </button>
          ))}
        </div>
        {playoffFormat !== "none" && (
          <div>
            <div className={sectionLabel}>Playoff Teams: {playoffTeams}</div>
            <input
              type="range"
              min="2"
              max={Math.max(selectedTeams.size - 1, 2)}
              step="1"
              value={playoffTeams}
              onChange={e => setPlayoffTeams(parseInt(e.target.value))}
              className="w-full sm:w-48 accent-orange-500"
            />
          </div>
        )}
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={impactPlayer} onChange={e => setImpactPlayer(e.target.checked)} className="accent-orange-500" />
          <span className="text-sm text-th-secondary font-display">Impact Player</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={injuriesEnabled} onChange={e => setInjuriesEnabled(e.target.checked)} className="accent-orange-500" />
          <span className="text-sm text-th-secondary font-display">Injuries</span>
        </label>
        <div>
          <span className="text-sm text-th-secondary font-display mr-2">Overseas in XI:</span>
          <input
            type="number"
            min="1"
            max="6"
            value={maxOverseasInXI}
            onChange={e => setMaxOverseasInXI(parseInt(e.target.value) || 4)}
            className={`${inputClass} w-16 text-center`}
          />
        </div>
      </div>

      {/* Apply */}
      <button
        onClick={apply}
        disabled={selectedTeams.size < 2}
        className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-40 text-white font-display font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 w-full sm:w-auto"
      >
        Apply Custom Rules
      </button>
    </div>
  );
}

export function SetupPage({ teams, rules, onRulesChange, onSelectTeam, slots, onLoadSlot }: Props) {
  const isWPL = rules.league === "wpl";
  const isCustom = rules.league === "custom";
  const isModern = rules.impactPlayer;
  const [showCustom, setShowCustom] = useState(isCustom);

  const leagueLabel = rules.leagueName ?? (isWPL ? "WPL" : isCustom ? (rules.leagueName || "Custom") : "IPL");

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
      {/* Hero */}
      <div className="text-center mb-12 relative">
        <div
          className="absolute inset-0 -top-20 -z-10 opacity-30 blur-3xl"
          style={{
            background: isWPL
              ? "radial-gradient(ellipse at center, #7c3aed40, transparent 70%)"
              : isCustom
                ? "radial-gradient(ellipse at center, #10b98140, transparent 70%)"
                : "radial-gradient(ellipse at center, #FF822A20, transparent 70%)",
          }}
        />
        <h1 className="text-5xl sm:text-6xl font-display font-extrabold tracking-tight mb-3">
          <span className="text-gradient-orange">{leagueLabel}</span>
          <span className="text-th-primary ml-3">Simulator</span>
        </h1>
        <p className="text-th-muted text-lg font-display">Choose your franchise to begin</p>
      </div>

      {/* League Toggle */}
      <fieldset className="flex justify-center gap-2 mb-6 border-0 p-0 m-0">
        <legend className="sr-only">Select league type</legend>
        <button
          onClick={() => { setShowCustom(false); onRulesChange(RULE_PRESETS.modern); }}
          className={`px-5 py-2.5 rounded-lg text-sm font-display font-semibold transition-all duration-200 border ${
            !isWPL && !isCustom && !showCustom
              ? "bg-blue-600/90 border-blue-500/50 text-white shadow-lg shadow-blue-500/20"
              : "bg-th-surface border-th text-th-muted hover:text-th-primary hover:bg-th-hover"
          }`}
        >
          IPL (Men's)
        </button>
        <button
          onClick={() => { setShowCustom(false); onRulesChange(RULE_PRESETS.wpl); }}
          className={`px-5 py-2.5 rounded-lg text-sm font-display font-semibold transition-all duration-200 border ${
            isWPL && !showCustom
              ? "bg-purple-600/90 border-purple-500/50 text-white shadow-lg shadow-purple-500/20"
              : "bg-th-surface border-th text-th-muted hover:text-th-primary hover:bg-th-hover"
          }`}
        >
          WPL (Women's)
        </button>
        <button
          onClick={() => setShowCustom(true)}
          className={`px-5 py-2.5 rounded-lg text-sm font-display font-semibold transition-all duration-200 border ${
            showCustom
              ? "bg-emerald-600/90 border-emerald-500/50 text-white shadow-lg shadow-emerald-500/20"
              : "bg-th-surface border-th text-th-muted hover:text-th-primary hover:bg-th-hover"
          }`}
        >
          Custom
        </button>
      </fieldset>

      {/* Custom League Panel */}
      {showCustom && (
        <CustomLeaguePanel rules={rules} onRulesChange={(r) => { onRulesChange(r); }} />
      )}

      {/* Era Toggle (IPL only) */}
      {!isWPL && !isCustom && !showCustom && (
        <div className="flex justify-center mb-6">
          <div className="inline-flex rounded-lg border border-th overflow-hidden">
            <button
              onClick={() => onRulesChange(RULE_PRESETS.classic)}
              className={`px-4 py-2 text-xs font-display font-medium transition-all duration-200 ${
                !isModern
                  ? "bg-white/10 text-th-primary"
                  : "bg-transparent text-th-muted hover:text-th-primary hover:bg-th-hover"
              }`}
            >
              Classic (Pre-2023)
            </button>
            <button
              onClick={() => onRulesChange(RULE_PRESETS.modern)}
              className={`px-4 py-2 text-xs font-display font-medium transition-all duration-200 border-l border-th ${
                isModern
                  ? "bg-white/10 text-th-primary"
                  : "bg-transparent text-th-muted hover:text-th-primary hover:bg-th-hover"
              }`}
            >
              Modern (2023+)
            </button>
          </div>
        </div>
      )}

      {/* Rule summary */}
      <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-th-muted mb-6 font-mono">
        <span>{teams.length} teams</span>
        <span className="text-th-faint">|</span>
        <span>Impact: <span className={rules.impactPlayer ? "text-emerald-400" : "text-th-muted"}>{rules.impactPlayer ? "ON" : "OFF"}</span></span>
        <span className="text-th-faint">|</span>
        <span>OS in XI: <span className="text-th-secondary">{rules.maxOverseasInXI}</span></span>
        <span className="text-th-faint">|</span>
        <span>Cap: <span className="text-th-secondary">{rules.salaryCap}Cr</span></span>
        <span className="text-th-faint">|</span>
        <span>Playoffs: <span className="text-th-secondary">
          {rules.playoffFormat === "none" ? "None" : `Top ${rules.playoffTeams} ${rules.playoffFormat ?? "eliminator"}`}
        </span></span>
      </div>

      {/* Injuries toggle (preset leagues only) */}
      {!showCustom && (
        <div className="flex justify-center mb-10">
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="flex flex-col items-end">
              <span className="text-sm font-display font-medium text-th-primary group-hover:text-th-primary transition-colors">
                Injuries
              </span>
              <span className="text-[11px] text-th-muted leading-tight">
                Players can get injured and miss games
              </span>
            </div>
            <button
              role="switch"
              aria-checked={rules.injuriesEnabled ?? true}
              onClick={() => onRulesChange({ ...rules, injuriesEnabled: !(rules.injuriesEnabled ?? true) })}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:ring-offset-2 focus:ring-offset-gray-950 ${
                (rules.injuriesEnabled ?? true)
                  ? "bg-orange-500"
                  : "bg-th-overlay"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  (rules.injuriesEnabled ?? true) ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </div>
      )}

      {/* Team grid */}
      <div className={`grid gap-3 sm:gap-4 stagger ${teams.length <= 5 ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-5" : "grid-cols-2 sm:grid-cols-3 md:grid-cols-5"}`}>
        {teams.map(team => (
          <button
            key={team.id}
            onClick={() => onSelectTeam(team.id)}
            className="group relative p-4 sm:p-5 rounded-2xl border border-th transition-all duration-300 hover:scale-[1.04] hover:border-th-strong"
            style={{
              background: `linear-gradient(160deg, ${team.config.primaryColor}10, transparent 60%)`,
            }}
          >
            <div
              className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 -z-10 blur-xl"
              style={{ background: `${team.config.primaryColor}15` }}
            />
            <div className="mx-auto mb-3">
              <TeamBadge teamId={team.id} shortName={team.shortName} primaryColor={team.config.primaryColor} />
            </div>
            <div className="text-th-primary text-sm font-display font-semibold text-center leading-tight">{team.name}</div>
            <div className="text-th-muted text-[11px] text-center mt-1.5 font-mono">
              {team.roster.length}p
              <span className="text-th-faint mx-1">/</span>
              PWR {team.powerRating}
            </div>
          </button>
        ))}
      </div>

      {/* Saved Games */}
      {slots && slots.length > 0 && onLoadSlot && (
        <div className="mt-10">
          <h3 className="text-sm font-semibold text-th-muted uppercase tracking-wider mb-4 text-center">Continue a Saved Game</h3>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {slots
              .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
              .slice(0, 6)
              .map(slot => (
              <button
                key={slot.id}
                onClick={() => onLoadSlot(slot.id)}
                className="text-left p-4 rounded-xl border border-th bg-th-surface hover:bg-th-hover hover:border-th-strong transition-all duration-200"
              >
                <div className="text-th-primary text-sm font-medium truncate">{slot.name}</div>
                <div className="flex items-center gap-2 mt-1 text-xs text-th-muted">
                  <span className={`uppercase font-medium ${slot.league === "wpl" ? "text-purple-400" : "text-blue-400"}`}>
                    {slot.league}
                  </span>
                  <span>Season {slot.season}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-14 text-center text-th-faint text-sm font-display">
        <p>Ball-by-ball T20 simulation with real {isWPL ? "WPL" : "IPL"} players</p>
        <p className="mt-1 text-th-faint">
          {isCustom
            ? `Custom league \u2022 ${teams.length} teams \u2022 ${rules.matchesPerTeam} matches/team`
            : isWPL
              ? "Auction \u2022 8-match season \u2022 Top 3 Playoffs \u2022 Multi-season"
              : "Auction \u2022 70-match season \u2022 Playoffs \u2022 Multi-season progression"}
        </p>
      </div>
    </div>
  );
}
