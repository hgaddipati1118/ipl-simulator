import { useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { GameState } from "../game-state";
import { ovrBgClass, roleLabel, teamLabelColor } from "../ui-utils";
import { TeamBadge } from "../components/TeamBadge";
import { RadarChart } from "../components/RadarChart";

interface Props {
  state: GameState;
}

/** Color for an attribute bar based on value 0-99 */
function attrBarColor(val: number): string {
  if (val >= 80) return "bg-emerald-500";
  if (val >= 60) return "bg-blue-500";
  if (val >= 40) return "bg-amber-500";
  return "bg-red-500";
}

function attrTextColor(val: number): string {
  if (val >= 80) return "text-emerald-400";
  if (val >= 60) return "text-blue-400";
  if (val >= 40) return "text-amber-400";
  return "text-red-400";
}

const ROLE_BADGE: Record<string, { bg: string; text: string }> = {
  batsman: { bg: "bg-orange-500/15 border-orange-500/30", text: "text-orange-400" },
  bowler: { bg: "bg-purple-500/15 border-purple-500/30", text: "text-purple-400" },
  "all-rounder": { bg: "bg-emerald-500/15 border-emerald-500/30", text: "text-emerald-400" },
};

export function PlayerPage({ state }: Props) {
  const { playerId } = useParams();
  const navigate = useNavigate();

  // Find the player across all teams
  const { player, team } = useMemo(() => {
    for (const t of state.teams) {
      const p = t.roster.find(r => r.id === playerId);
      if (p) return { player: p, team: t };
    }
    return { player: null, team: null };
  }, [state.teams, playerId]);

  // Get prev/next player within same team
  const { prevPlayer, nextPlayer } = useMemo(() => {
    if (!team || !player) return { prevPlayer: null, nextPlayer: null };
    const sorted = [...team.roster].sort((a, b) => b.overall - a.overall);
    const idx = sorted.findIndex(p => p.id === player.id);
    return {
      prevPlayer: idx > 0 ? sorted[idx - 1] : null,
      nextPlayer: idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
  }, [team, player]);

  // Build match-by-match log from matchResults
  const matchLog = useMemo(() => {
    if (!player || !team) return [];

    const log: {
      matchIndex: number;
      opponent: string;
      opponentShort: string;
      batting: { runs: number; balls: number; fours: number; sixes: number; sr: number } | null;
      bowling: { overs: string; runs: number; wickets: number; econ: number } | null;
      result: "W" | "L" | "T";
    }[] = [];

    // Go through schedule + matchResults
    const schedule = state.schedule.length > 0 ? state.schedule : state.seasonResult?.schedule ?? [];

    for (let i = 0; i < schedule.length; i++) {
      const match = schedule[i];
      if (!match.result) continue;

      const isHome = match.homeTeamId === team.id;
      const isAway = match.awayTeamId === team.id;
      if (!isHome && !isAway) continue;

      const opponentId = isHome ? match.awayTeamId : match.homeTeamId;
      const opponentTeam = state.teams.find(t => t.id === opponentId);

      // Check if this player has stats in this match
      // Look in the serializable match result
      const smr = state.matchResults[i];
      if (!smr) continue;

      // Check both innings for this player's batting/bowling stats
      let batting: typeof log[0]["batting"] = null;
      let bowling: typeof log[0]["bowling"] = null;

      for (const inn of smr.innings) {
        // Check batting
        const batterStat = inn.batterStats?.[player.id];
        if (batterStat && (batterStat.balls > 0 || batterStat.isOut)) {
          batting = {
            runs: batterStat.runs,
            balls: batterStat.balls,
            fours: batterStat.fours,
            sixes: batterStat.sixes,
            sr: batterStat.balls > 0 ? (batterStat.runs / batterStat.balls) * 100 : 0,
          };
        }

        // Check bowling
        const bowlerStat = inn.bowlerStats?.[player.id];
        if (bowlerStat && (bowlerStat.overs > 0 || bowlerStat.balls > 0)) {
          const oversDisplay = bowlerStat.balls > 0 ? `${bowlerStat.overs}.${bowlerStat.balls}` : `${bowlerStat.overs}`;
          const totalOvers = bowlerStat.overs + bowlerStat.balls / 6;
          bowling = {
            overs: oversDisplay,
            runs: bowlerStat.runs,
            wickets: bowlerStat.wickets,
            econ: totalOvers > 0 ? bowlerStat.runs / totalOvers : 0,
          };
        }
      }

      // Only add if player participated
      if (!batting && !bowling) continue;

      const wonMatch = match.result.winnerId === team.id;
      const tied = match.result.winnerId === null;

      log.push({
        matchIndex: i,
        opponent: opponentTeam?.name ?? opponentId,
        opponentShort: opponentTeam?.shortName ?? opponentId,
        batting,
        bowling,
        result: tied ? "T" : wonMatch ? "W" : "L",
      });
    }

    return log;
  }, [player, team, state]);

  // Compute season stats from match log
  const seasonStats = useMemo(() => {
    if (!player) return null;
    // Use the player's accumulated stats object
    const s = player.stats;
    const dismissals = s.innings - s.notOuts;
    const avg = dismissals > 0 ? s.runs / dismissals : s.runs;
    const sr = s.ballsFaced > 0 ? (s.runs / s.ballsFaced) * 100 : 0;
    const bowlAvg = s.wickets > 0 ? s.runsConceded / s.wickets : 0;
    const econ = s.overs > 0 ? s.runsConceded / s.overs : 0;

    // Count batting/bowling innings from match log
    const battingInnings = matchLog.filter(m => m.batting !== null).length;
    const bowlingInnings = matchLog.filter(m => m.bowling !== null).length;

    return {
      matches: s.matches,
      battingInnings,
      runs: s.runs,
      avg,
      sr,
      highScore: s.highScore,
      fours: s.fours,
      sixes: s.sixes,
      fifties: s.fifties,
      hundreds: s.hundreds,
      bowlingInnings,
      overs: s.overs,
      runsConceded: s.runsConceded,
      wickets: s.wickets,
      bowlAvg,
      econ,
      bestBowling: s.bestBowling,
      catches: s.catches,
    };
  }, [player, matchLog]);

  // Find best performances
  const bestBatting = useMemo(() => {
    const withBat = matchLog.filter(m => m.batting !== null);
    if (withBat.length === 0) return null;
    return withBat.reduce((best, m) => (m.batting!.runs > (best.batting?.runs ?? -1) ? m : best), withBat[0]);
  }, [matchLog]);

  const bestBowling = useMemo(() => {
    const withBowl = matchLog.filter(m => m.bowling !== null);
    if (withBowl.length === 0) return null;
    return withBowl.reduce((best, m) => {
      const mw = m.bowling!.wickets;
      const bw = best.bowling?.wickets ?? -1;
      if (mw > bw) return m;
      if (mw === bw && m.bowling!.runs < (best.bowling?.runs ?? Infinity)) return m;
      return best;
    }, withBowl[0]);
  }, [matchLog]);

  if (!player || !team) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <p className="text-th-secondary">Player not found.</p>
        <button onClick={() => navigate(-1)} className="text-blue-400 hover:text-blue-300 text-sm mt-4">
          Go Back
        </button>
      </div>
    );
  }

  const rb = ROLE_BADGE[player.role] ?? ROLE_BADGE.batsman;

  const attrs = [
    { key: "battingIQ", label: "Batting IQ", val: player.ratings.battingIQ, group: "bat" },
    { key: "timing", label: "Timing", val: player.ratings.timing, group: "bat" },
    { key: "power", label: "Power", val: player.ratings.power, group: "bat" },
    { key: "running", label: "Running", val: player.ratings.running, group: "bat" },
    { key: "wicketTaking", label: "Wicket Taking", val: player.ratings.wicketTaking, group: "bowl" },
    { key: "economy", label: "Economy", val: player.ratings.economy, group: "bowl" },
    { key: "accuracy", label: "Accuracy", val: player.ratings.accuracy, group: "bowl" },
    { key: "clutch", label: "Clutch", val: player.ratings.clutch, group: "clutch" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Navigation */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => navigate(`/team/${team.id}`)}
          className="text-th-muted hover:text-th-primary text-sm font-display flex items-center gap-1.5 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to {team.shortName}
        </button>
        <div className="flex items-center gap-2">
          {prevPlayer && (
            <Link
              to={`/player/${prevPlayer.id}`}
              className="text-th-muted hover:text-th-primary text-sm px-3 py-1.5 rounded-lg border border-th hover:border-th-strong transition-colors"
            >
              <svg className="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Prev
            </Link>
          )}
          {nextPlayer && (
            <Link
              to={`/player/${nextPlayer.id}`}
              className="text-th-muted hover:text-th-primary text-sm px-3 py-1.5 rounded-lg border border-th hover:border-th-strong transition-colors"
            >
              Next
              <svg className="w-4 h-4 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          )}
        </div>
      </div>

      {/* Player Bio Header */}
      <div
        className="rounded-2xl p-5 sm:p-6 mb-6 border border-th relative overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${team.config.primaryColor}12, transparent 60%)` }}
      >
        <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: team.config.primaryColor }} />
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <TeamBadge teamId={team.id} shortName={team.shortName} primaryColor={team.config.primaryColor} size="md" />
          <div className="flex-1">
            <h2 className="text-2xl sm:text-3xl font-display font-extrabold text-th-primary tracking-tight">{player.name}</h2>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Link
                to={`/team/${team.id}`}
                className="text-sm font-display font-medium hover:underline"
                style={{ color: teamLabelColor(team.config.primaryColor) }}
              >
                {team.name}
              </Link>
              <span className="text-th-faint">|</span>
              <span className={`text-xs font-display font-semibold px-2 py-0.5 rounded-full border ${rb.bg} ${rb.text}`}>
                {roleLabel(player.role)}
              </span>
              <span className="text-th-faint">|</span>
              <span className="text-th-muted text-sm font-display">Age {player.age}</span>
              <span className="text-th-faint">|</span>
              <span className="text-th-muted text-sm font-display">{player.country}</span>
              {player.isInternational && (
                <span className="text-blue-400/70 text-[10px] font-display font-semibold bg-blue-500/10 px-1.5 py-0.5 rounded">OVERSEAS</span>
              )}
              {player.isWicketKeeper && (
                <span className="text-cyan-400/70 text-[10px] font-display font-semibold bg-cyan-500/10 px-1.5 py-0.5 rounded">WK</span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className={`ovr-badge text-2xl inline-block min-w-[40px] rounded-lg px-2 py-1 font-display font-bold ${ovrBgClass(player.overall)}`}>
              {player.overall}
            </div>
            <div className="text-th-faint text-[10px] uppercase tracking-wider mt-1 font-display">Overall</div>
          </div>
        </div>

        {/* Injury status */}
        {player.injured && (
          <div className="mt-4 bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="text-red-400 text-sm font-display font-semibold">INJURED</span>
            <span className="text-red-300/80 text-sm">{player.injuryType ?? "Unknown injury"}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-display font-semibold ${
              player.injurySeverity === "severe" ? "bg-red-900/40 text-red-300" :
              player.injurySeverity === "moderate" ? "bg-orange-900/40 text-orange-400" :
              "bg-yellow-900/40 text-yellow-400"
            }`}>
              {player.injurySeverity ?? "minor"}
            </span>
            <span className="text-th-muted text-xs">
              {player.injuryGamesLeft} {player.injuryGamesLeft === 1 ? "match" : "matches"} remaining
            </span>
          </div>
        )}
      </div>

      {/* Ratings + Stats Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        {/* Attribute Ratings Card */}
        <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Attributes</h3>
            <div className="flex gap-3">
              <span className="text-orange-300/70 text-xs font-display">BAT <span className="stat-num font-bold">{player.battingOvr}</span></span>
              <span className="text-purple-300/70 text-xs font-display">BWL <span className="stat-num font-bold">{player.bowlingOvr}</span></span>
            </div>
          </div>
          {/* Radar chart */}
          <div className="flex justify-center mb-5">
            <RadarChart
              attributes={[
                { label: "CLT", value: player.ratings.clutch },
                { label: "IQ", value: player.ratings.battingIQ },
                { label: "TIM", value: player.ratings.timing },
                { label: "PWR", value: player.ratings.power },
                { label: "RUN", value: player.ratings.running },
                { label: "WKT", value: player.ratings.wicketTaking },
                { label: "ECN", value: player.ratings.economy },
                { label: "ACC", value: player.ratings.accuracy },
              ]}
              teamColor={team?.config.primaryColor}
              size={200}
            />
          </div>

          <div className="space-y-3">
            {attrs.map(a => (
              <div key={a.key} className="flex items-center gap-3">
                <span className="text-th-muted text-xs font-display w-24 flex-shrink-0">{a.label}</span>
                <div
                  className="flex-1 h-2 bg-th-raised rounded-full overflow-hidden"
                  role="progressbar"
                  aria-valuenow={a.val}
                  aria-valuemin={0}
                  aria-valuemax={99}
                  aria-label={`${a.label} rating`}
                >
                  <div
                    className={`h-full rounded-full ${attrBarColor(a.val)} transition-all duration-500`}
                    style={{ width: `${a.val}%` }}
                  />
                </div>
                <span className={`stat-num text-sm font-bold w-8 text-right ${attrTextColor(a.val)}`}>{a.val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Season Stats Card */}
        {seasonStats && seasonStats.matches > 0 ? (
          <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5">
            <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider mb-4">Current Season Stats</h3>

            {/* Batting Stats */}
            <div className="mb-4">
              <div className="text-[10px] text-orange-400/60 uppercase tracking-wider font-display font-semibold mb-2">Batting</div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                <MiniStat label="M" value={String(seasonStats.matches)} />
                <MiniStat label="Inn" value={String(seasonStats.battingInnings)} />
                <MiniStat label="Runs" value={String(seasonStats.runs)} highlight />
                <MiniStat label="Avg" value={seasonStats.avg.toFixed(1)} />
                <MiniStat label="SR" value={seasonStats.sr.toFixed(1)} />
                <MiniStat label="HS" value={String(seasonStats.highScore)} />
                <MiniStat label="4s" value={String(seasonStats.fours)} />
                <MiniStat label="6s" value={String(seasonStats.sixes)} />
                <MiniStat label="50s" value={String(seasonStats.fifties)} />
                <MiniStat label="100s" value={String(seasonStats.hundreds)} />
              </div>
            </div>

            {/* Bowling Stats */}
            <div className="mb-4">
              <div className="text-[10px] text-purple-400/60 uppercase tracking-wider font-display font-semibold mb-2">Bowling</div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                <MiniStat label="Inn" value={String(seasonStats.bowlingInnings)} />
                <MiniStat label="Overs" value={String(seasonStats.overs)} />
                <MiniStat label="Runs" value={String(seasonStats.runsConceded)} />
                <MiniStat label="Wkts" value={String(seasonStats.wickets)} highlight />
                <MiniStat label="Avg" value={seasonStats.wickets > 0 ? seasonStats.bowlAvg.toFixed(1) : "-"} />
                <MiniStat label="Econ" value={seasonStats.overs > 0 ? seasonStats.econ.toFixed(1) : "-"} />
                <MiniStat label="Best" value={seasonStats.bestBowling} />
                <MiniStat label="Ct" value={String(seasonStats.catches)} />
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-th bg-th-surface p-4 sm:p-5 flex items-center justify-center">
            <p className="text-th-faint text-sm font-display">No matches played this season</p>
          </div>
        )}
      </div>

      {/* Match-by-Match Performance Log */}
      {matchLog.length > 0 && (
        <div className="rounded-2xl border border-th overflow-hidden bg-th-surface mb-6">
          <div className="px-4 py-3 border-b border-th">
            <h3 className="text-xs font-display font-semibold text-th-secondary uppercase tracking-wider">Match Log</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-th-faint text-[11px] uppercase font-display tracking-wider border-b border-th">
                  <th className="text-left px-3 py-2.5">#</th>
                  <th className="text-left px-3 py-2.5">vs</th>
                  <th className="text-center px-2 py-2.5">R</th>
                  <th className="text-center px-2 py-2.5">B</th>
                  <th className="text-center px-2 py-2.5">4s</th>
                  <th className="text-center px-2 py-2.5">6s</th>
                  <th className="text-center px-2 py-2.5">SR</th>
                  <th className="text-center px-2 py-2.5 border-l border-th">O</th>
                  <th className="text-center px-2 py-2.5">R</th>
                  <th className="text-center px-2 py-2.5">W</th>
                  <th className="text-center px-2 py-2.5">Econ</th>
                  <th className="text-center px-2 py-2.5">Res</th>
                </tr>
              </thead>
              <tbody>
                {matchLog.map((m, i) => {
                  const isBestBat = bestBatting?.matchIndex === m.matchIndex;
                  const isBestBowl = bestBowling?.matchIndex === m.matchIndex;
                  return (
                    <tr
                      key={m.matchIndex}
                      className={`border-t border-th cursor-pointer hover:bg-th-hover transition-colors ${
                        isBestBat ? "bg-orange-500/[0.04]" : isBestBowl ? "bg-purple-500/[0.04]" : ""
                      }`}
                      onClick={() => navigate(`/match/${m.matchIndex}`)}
                    >
                      <td className="px-3 py-2 text-th-faint text-xs stat-num">{i + 1}</td>
                      <td className="px-3 py-2 text-th-secondary text-xs font-display font-medium">{m.opponentShort}</td>
                      <td className={`text-center px-2 py-2 stat-num ${isBestBat ? "text-orange-400 font-bold" : "text-th-primary"}`}>
                        {m.batting?.runs ?? "-"}
                      </td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted">{m.batting?.balls ?? "-"}</td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted">{m.batting?.fours ?? "-"}</td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted">{m.batting?.sixes ?? "-"}</td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted">{m.batting ? m.batting.sr.toFixed(1) : "-"}</td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted border-l border-th">{m.bowling?.overs ?? "-"}</td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted">{m.bowling?.runs ?? "-"}</td>
                      <td className={`text-center px-2 py-2 stat-num ${isBestBowl ? "text-purple-400 font-bold" : "text-th-primary"}`}>
                        {m.bowling?.wickets ?? "-"}
                      </td>
                      <td className="text-center px-2 py-2 stat-num text-th-muted">{m.bowling ? m.bowling.econ.toFixed(1) : "-"}</td>
                      <td className="text-center px-2 py-2">
                        <span className={`text-xs font-display font-semibold px-1.5 py-0.5 rounded ${
                          m.result === "W" ? "bg-emerald-500/15 text-emerald-400" :
                          m.result === "L" ? "bg-red-500/15 text-red-400" :
                          "bg-gray-500/15 text-th-secondary"
                        }`}>
                          {m.result}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-th-surface rounded-lg px-2.5 py-1.5">
      <div className="text-th-faint text-[9px] uppercase font-display tracking-wider">{label}</div>
      <div className={`font-display font-semibold stat-num text-sm ${highlight ? "text-th-primary" : "text-th-secondary"}`}>{value}</div>
    </div>
  );
}
