import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { GameState } from "../game-state";
import { getMatchDetail } from "../match-db";
import { getActiveSlotId } from "../storage";
import { PlayerLink } from "../components/PlayerLink";
import { getDrsVerdict, getDrsVerdictLabel } from "../drs-utils";
import type {
  DetailedMatchResult,
  InningsScorecard,
  DetailedBallEvent,
  BatterInnings,
  BowlerFigures,
} from "@ipl-sim/engine";

interface Props {
  state: GameState;
}

export function MatchPage({ state }: Props) {
  const { matchIndex } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<1 | 2>(1);
  const [commentaryOpen, setCommentaryOpen] = useState(false);
  const [expandedOvers, setExpandedOvers] = useState<Set<string>>(new Set());

  // IndexedDB async loading state
  const [idbDetail, setIdbDetail] = useState<DetailedMatchResult | null>(null);
  const [idbLoading, setIdbLoading] = useState(false);

  const idx = Number(matchIndex);
  // Use the live schedule if available (match-by-match mode), otherwise fall back to season result
  const schedule = state.schedule.length > 0 ? state.schedule : state.seasonResult?.schedule;

  const match = schedule && !isNaN(idx) && idx >= 0 && idx < schedule.length
    ? schedule[idx]
    : null;

  // Check multiple sources for detailed data:
  // 1. Route location state (passed when navigating from playNextMatch — avoids IDB race)
  // 2. In-memory on the schedule entry
  // 3. IndexedDB (async fallback for page reloads / navigating to older matches)
  const routeDetailed = (location.state as { detailed?: DetailedMatchResult } | null)?.detailed ?? null;
  const inMemoryDetailed = match?.result?.detailed ?? null;
  const immediateDetailed = routeDetailed ?? inMemoryDetailed;

  useEffect(() => {
    // Reset when matchIndex changes
    setIdbDetail(null);

    // Only fetch from IndexedDB if no immediate detailed data is available
    if (immediateDetailed || !match) return;

    setIdbLoading(true);
    getMatchDetail(getActiveSlotId(), state.seasonNumber, idx).then(detail => {
      setIdbDetail(detail);
      setIdbLoading(false);
    }).catch(() => {
      setIdbLoading(false);
    });
  }, [idx, state.seasonNumber, !!immediateDetailed, !!match]);

  if (!schedule || !match) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <p className="text-th-secondary">Match not found.</p>
        <button onClick={() => navigate("/season")} className="text-blue-400 hover:text-blue-300 text-sm mt-4">
          Back to Season
        </button>
      </div>
    );
  }

  // Show skeleton while fetching from IndexedDB
  if (!immediateDetailed && idbLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="rounded-2xl border border-th bg-th-surface p-6 space-y-4">
          <div className="flex justify-between">
            <div className="h-6 w-24 bg-th-raised rounded animate-pulse" />
            <div className="h-6 w-16 bg-th-raised rounded animate-pulse" />
            <div className="h-6 w-24 bg-th-raised rounded animate-pulse" />
          </div>
          <div className="h-4 w-64 mx-auto bg-th-raised rounded animate-pulse" />
          <div className="space-y-2 mt-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-8 bg-th-raised/40 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const detailed = immediateDetailed ?? idbDetail;
  if (!detailed) {
    // No detailed data available (old match before IndexedDB was added)
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <button onClick={() => navigate("/season")} className="text-th-secondary hover:text-th-primary text-sm mb-6">
          &larr; Back to Season
        </button>
        <div className="bg-th-surface rounded-xl border border-th p-6 text-center">
          <p className="text-th-secondary mb-2">Detailed match scorecard not available.</p>
          <p className="text-th-muted text-sm">
            {match.result
              ? "This match was played before detailed data storage was enabled."
              : "This match has not been played yet."}
          </p>
        </div>
      </div>
    );
  }

  const homeTeam = state.teams.find(t => t.id === detailed.homeTeamId);
  const awayTeam = state.teams.find(t => t.id === detailed.awayTeamId);

  const activeInnings = activeTab === 1 ? detailed.innings1 : detailed.innings2;
  const activeBalls = detailed.ballLog.filter(b => b.innings === activeTab);

  // Group balls by over for commentary
  const overGroups = groupByOver(activeBalls);

  const toggleOver = (key: string) => {
    setExpandedOvers(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Navigation
  const prevIdx = idx > 0 ? idx - 1 : null;
  const nextIdx = idx < schedule.length - 1 ? idx + 1 : null;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Navigation bar */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button onClick={() => navigate("/season")} className="text-th-secondary hover:text-th-primary text-sm">
          &larr; Back to Season
        </button>
        <div className="flex items-center gap-3">
          {prevIdx !== null && (
            <button
              onClick={() => navigate(`/match/${prevIdx}`)}
              className="text-th-secondary hover:text-th-primary text-sm px-3 py-1 rounded border border-th hover:border-th-strong"
            >
              &larr; Prev Match
            </button>
          )}
          {nextIdx !== null && (
            <button
              onClick={() => navigate(`/match/${nextIdx}`)}
              className="text-th-secondary hover:text-th-primary text-sm px-3 py-1 rounded border border-th hover:border-th-strong"
            >
              Next Match &rarr;
            </button>
          )}
        </div>
      </div>

      {/* Header */}
      <MatchHeader
        detailed={detailed}
        matchNumber={match.matchNumber}
        isPlayoff={match.isPlayoff}
        playoffType={match.playoffType}
        homeColor={homeTeam?.config.primaryColor ?? "#004BA0"}
        awayColor={awayTeam?.config.primaryColor ?? "#FF822A"}
        homeShort={homeTeam?.shortName ?? "HOM"}
        awayShort={awayTeam?.shortName ?? "AWY"}
      />

      {/* Innings Tabs */}
      <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          onClick={() => setActiveTab(1)}
          className={`rounded-lg px-4 py-3 text-left text-sm font-semibold transition-colors sm:text-center ${
            activeTab === 1
              ? "bg-blue-600 text-white"
              : "bg-th-raised text-th-secondary hover:bg-th-hover hover:text-th-primary"
          }`}
        >
          <span className="block">1st Innings &mdash; {detailed.innings1.battingTeamName}</span>
          <span className="mt-1 block text-xs opacity-75">
            {detailed.innings1.totalRuns}/{detailed.innings1.totalWickets} ({detailed.innings1.totalOvers} ov)
          </span>
        </button>
        <button
          onClick={() => setActiveTab(2)}
          className={`rounded-lg px-4 py-3 text-left text-sm font-semibold transition-colors sm:text-center ${
            activeTab === 2
              ? "bg-blue-600 text-white"
              : "bg-th-raised text-th-secondary hover:bg-th-hover hover:text-th-primary"
          }`}
        >
          <span className="block">2nd Innings &mdash; {detailed.innings2.battingTeamName}</span>
          <span className="mt-1 block text-xs opacity-75">
            {detailed.innings2.totalRuns}/{detailed.innings2.totalWickets} ({detailed.innings2.totalOvers} ov)
          </span>
        </button>
      </div>

      {/* Scorecard */}
      <BattingCard innings={activeInnings} />
      <BowlingCard innings={activeInnings} />

      {/* Fall of Wickets */}
      {activeInnings.fallOfWickets.length > 0 && (
        <div className="bg-th-surface rounded-xl border border-th p-4 mb-6">
          <h4 className="text-xs font-semibold text-th-muted uppercase tracking-wider mb-2">Fall of Wickets</h4>
          <div className="flex flex-wrap gap-2">
            {activeInnings.fallOfWickets.map((fow, i) => (
              <span key={i} className="text-th-secondary text-sm bg-th-raised px-2 py-1 rounded">
                {fow}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Ball-by-Ball Commentary (collapsible) */}
      <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-6">
        <button
          onClick={() => setCommentaryOpen(!commentaryOpen)}
          className="w-full px-4 py-3 bg-th-raised border-b border-th flex items-center justify-between hover:bg-th-hover transition-colors"
        >
          <h3 className="text-sm font-semibold text-th-primary uppercase tracking-wider">
            Ball-by-Ball Commentary
          </h3>
          <span className="text-th-muted text-xs">{commentaryOpen ? "Collapse" : "Expand"}</span>
        </button>
        {commentaryOpen && (
          <div className="p-4 space-y-2">
            {overGroups.map(group => {
              const overKey = `${activeTab}-${group.over}`;
              const isExpanded = expandedOvers.has(overKey);
              const lastBall = group.balls[group.balls.length - 1];
              const overRuns = group.balls.reduce((s, b) => s + b.runs + b.extras, 0);

              return (
                <div key={overKey} className="border border-th rounded-lg overflow-hidden">
                  {/* Over summary header */}
                  <button
                    onClick={() => toggleOver(overKey)}
                    className="flex w-full flex-col items-start gap-2 bg-th-raised px-3 py-2 transition-colors hover:bg-th-hover sm:flex-row sm:items-center sm:justify-between"
                    aria-expanded={isExpanded}
                  >
                    <span className="text-th-primary text-sm font-medium">
                      Over {group.over + 1}
                    </span>
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <span className="text-th-secondary">
                        {overRuns} runs
                      </span>
                      <span className="text-th-muted">
                        Score: {lastBall.scoreSoFar}/{lastBall.wicketsSoFar}
                      </span>
                      <span className="text-th-faint">{isExpanded ? "[-]" : "[+]"}</span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="px-3 py-2 space-y-1">
                      {group.balls.map((ball, bi) => (
                        <BallCommentaryRow key={bi} ball={ball} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───── Sub-components ───── */

function MatchHeader({
  detailed,
  matchNumber,
  isPlayoff,
  playoffType,
  homeColor,
  awayColor,
  homeShort,
  awayShort,
}: {
  detailed: DetailedMatchResult;
  matchNumber: number;
  isPlayoff: boolean;
  playoffType?: string;
  homeColor: string;
  awayColor: string;
  homeShort: string;
  awayShort: string;
}) {
  const matchLabel = isPlayoff
    ? playoffType === "final"
      ? "FINAL"
      : playoffType === "qualifier1"
      ? "Qualifier 1"
      : playoffType === "qualifier2"
      ? "Qualifier 2"
      : playoffType === "eliminator"
      ? "Eliminator"
      : `Match ${matchNumber}`
    : `Match ${matchNumber}`;

  // Determine which innings belongs to which team
  const inn1 = detailed.innings1;
  const inn2 = detailed.innings2;

  // Home/away score lines
  const homeInn = inn1.battingTeamId === detailed.homeTeamId ? inn1 : inn2;
  const awayInn = inn1.battingTeamId === detailed.awayTeamId ? inn1 : inn2;

  return (
    <div className="bg-th-surface rounded-xl border border-th p-4 sm:p-6 mb-6">
      {/* Match info */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-th-muted text-xs uppercase tracking-wider font-semibold">
          {matchLabel}
        </span>
        <span className="text-th-faint text-xs">{detailed.venue}</span>
      </div>

      {/* Scoreboard */}
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Home team */}
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold"
            style={{ backgroundColor: homeColor }}
          >
            {homeShort.slice(0, 3)}
          </div>
          <div>
            <p className="text-th-primary font-semibold">{detailed.homeTeamName}</p>
            <p className="text-th-secondary text-lg font-bold">
              {homeInn.totalRuns}/{homeInn.totalWickets}
              <span className="text-th-muted text-sm font-normal ml-1">({homeInn.totalOvers} ov)</span>
            </p>
          </div>
        </div>

        <span className="text-th-faint text-lg font-bold">vs</span>

        {/* Away team */}
        <div className="flex items-center gap-3 self-end sm:self-auto">
          <div>
            <p className="text-th-primary font-semibold text-right">{detailed.awayTeamName}</p>
            <p className="text-th-secondary text-lg font-bold text-right">
              {awayInn.totalRuns}/{awayInn.totalWickets}
              <span className="text-th-muted text-sm font-normal ml-1">({awayInn.totalOvers} ov)</span>
            </p>
          </div>
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold"
            style={{ backgroundColor: awayColor }}
          >
            {awayShort.slice(0, 3)}
          </div>
        </div>
      </div>

      {/* Result */}
      <p className="text-center text-green-400 font-semibold text-sm mb-3">
        {detailed.result}
      </p>

      {/* Toss + MOTM */}
      <div className="flex flex-col gap-2 text-xs text-th-muted sm:flex-row sm:items-center sm:justify-between">
        <span>Toss: {detailed.tossWinnerName} elected to {detailed.tossDecision} first</span>
        <span>
          MoM: <PlayerLink playerId={detailed.manOfTheMatch.playerId} className="text-gold-400 text-yellow-400 font-medium">{detailed.manOfTheMatch.playerName}</PlayerLink>
          {detailed.manOfTheMatch.reason && (
            <span className="text-th-faint ml-1">({detailed.manOfTheMatch.reason})</span>
          )}
        </span>
      </div>
    </div>
  );
}

function BattingCard({ innings }: { innings: InningsScorecard }) {
  const topScorer = innings.batters.reduce(
    (best, b) => (b.runs > best.runs ? b : best),
    { runs: -1 } as BatterInnings
  );

  return (
    <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-6">
      <div className="px-4 py-3 bg-th-raised border-b border-th">
        <h3 className="text-sm font-semibold text-th-primary uppercase tracking-wider">
          {innings.battingTeamName} &mdash; Batting
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-th-muted text-xs uppercase">
              <th scope="col" className="text-left px-4 py-2 w-[40%]">Batter</th>
              <th scope="col" className="text-left px-4 py-2 w-[25%]">How Out</th>
              <th scope="col" className="text-center px-2 py-2">R</th>
              <th scope="col" className="text-center px-2 py-2">B</th>
              <th scope="col" className="text-center px-2 py-2">4s</th>
              <th scope="col" className="text-center px-2 py-2">6s</th>
              <th scope="col" className="text-center px-2 py-2">SR</th>
            </tr>
          </thead>
          <tbody>
            {innings.batters.map((b, i) => {
              const isTop = b.playerId === topScorer.playerId && b.runs > 0;
              return (
                <tr
                  key={b.playerId}
                  className={`border-t border-th ${
                    i % 2 === 0 ? "bg-th-surface" : "bg-th-raised"
                  } ${isTop ? "bg-yellow-500/5" : ""}`}
                >
                  <td className="px-4 py-2">
                    <PlayerLink playerId={b.playerId} className={`font-medium ${isTop ? "text-yellow-400" : "text-th-primary"}`}>
                      {b.playerName}
                    </PlayerLink>
                    {isTop && <span className="text-yellow-500 text-xs ml-1">*</span>}
                  </td>
                  <td className="px-4 py-2 text-th-secondary text-xs">{b.howOut}</td>
                  <td className="text-center px-2 py-2 text-th-primary font-semibold">{b.runs}</td>
                  <td className="text-center px-2 py-2 text-th-secondary">{b.balls}</td>
                  <td className="text-center px-2 py-2 text-th-secondary">{b.fours}</td>
                  <td className="text-center px-2 py-2 text-th-secondary">{b.sixes}</td>
                  <td className="text-center px-2 py-2 text-th-muted">{b.strikeRate.toFixed(1)}</td>
                </tr>
              );
            })}
            {/* Extras row */}
            <tr className="border-t border-th">
              <td className="px-4 py-2 text-th-secondary text-xs" colSpan={2}>
                Extras: {innings.extras.total} (w {innings.extras.wides}, nb {innings.extras.noBalls}, lb {innings.extras.legByes})
              </td>
              <td colSpan={5}></td>
            </tr>
            {/* Total row */}
            <tr className="border-t border-th bg-th-raised">
              <td className="px-4 py-2 text-th-primary font-semibold" colSpan={2}>
                Total
              </td>
              <td className="text-center px-2 py-2 text-th-primary font-bold">{innings.totalRuns}</td>
              <td className="text-center px-2 py-2 text-th-secondary" colSpan={4}>
                ({innings.totalWickets} wkts, {innings.totalOvers} ov)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BowlingCard({ innings }: { innings: InningsScorecard }) {
  const bestBowler = innings.bowlers.reduce(
    (best, b) => {
      if (b.wickets > best.wickets) return b;
      if (b.wickets === best.wickets && b.runs < best.runs) return b;
      return best;
    },
    { wickets: -1, runs: Infinity } as BowlerFigures
  );

  return (
    <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-6">
      <div className="px-4 py-3 bg-th-raised border-b border-th">
        <h3 className="text-sm font-semibold text-th-primary uppercase tracking-wider">
          {innings.bowlingTeamName} &mdash; Bowling
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-th-muted text-xs uppercase">
              <th scope="col" className="text-left px-4 py-2">Bowler</th>
              <th scope="col" className="text-center px-2 py-2">O</th>
              <th scope="col" className="text-center px-2 py-2">M</th>
              <th scope="col" className="text-center px-2 py-2">R</th>
              <th scope="col" className="text-center px-2 py-2">W</th>
              <th scope="col" className="text-center px-2 py-2">Econ</th>
              <th scope="col" className="text-center px-2 py-2">Dots</th>
            </tr>
          </thead>
          <tbody>
            {innings.bowlers.map((b, i) => {
              const isBest = b.playerId === bestBowler.playerId && b.wickets > 0;
              return (
                <tr
                  key={b.playerId}
                  className={`border-t border-th ${
                    i % 2 === 0 ? "bg-th-surface" : "bg-th-raised"
                  } ${isBest ? "bg-green-500/5" : ""}`}
                >
                  <td className="px-4 py-2">
                    <PlayerLink playerId={b.playerId} className={`font-medium ${isBest ? "text-green-400" : "text-th-primary"}`}>
                      {b.playerName}
                    </PlayerLink>
                    {isBest && <span className="text-green-500 text-xs ml-1">*</span>}
                  </td>
                  <td className="text-center px-2 py-2 text-th-secondary">{b.overs}</td>
                  <td className="text-center px-2 py-2 text-th-secondary">{b.maidens}</td>
                  <td className="text-center px-2 py-2 text-th-secondary">{b.runs}</td>
                  <td className="text-center px-2 py-2 text-th-primary font-semibold">{b.wickets}</td>
                  <td className="text-center px-2 py-2 text-th-muted">{b.economy.toFixed(1)}</td>
                  <td className="text-center px-2 py-2 text-th-muted">{b.dots}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BallCommentaryRow({ ball }: { ball: DetailedBallEvent }) {
  const drsVerdict = getDrsVerdict(ball.commentary);
  let colorClass = "text-th-secondary";
  let bgClass = "";
  let drsBadgeClass = "";

  if (drsVerdict === "overturned") {
    colorClass = "text-red-100";
    bgClass = "bg-red-500/10";
    drsBadgeClass = "border-red-500/30 bg-red-500/10 text-red-300";
  } else if (drsVerdict === "umpires-call") {
    colorClass = "text-sky-100";
    bgClass = "bg-sky-500/10";
    drsBadgeClass = "border-sky-500/30 bg-sky-500/10 text-sky-200";
  } else if (drsVerdict === "review-lost") {
    colorClass = "text-amber-100";
    bgClass = "bg-amber-500/10";
    drsBadgeClass = "border-amber-500/30 bg-amber-500/10 text-amber-200";
  } else if (ball.eventType === "four") {
    colorClass = "text-green-400";
    bgClass = "bg-green-500/5";
  } else if (ball.eventType === "six") {
    colorClass = "text-green-300";
    bgClass = "bg-green-500/10";
  } else if (ball.eventType === "wicket") {
    colorClass = "text-red-400";
    bgClass = "bg-red-500/5";
  } else if (ball.eventType === "dot") {
    colorClass = "text-th-muted";
  } else if (ball.eventType === "wide" || ball.eventType === "noball") {
    colorClass = "text-yellow-500";
  }

  const overBall = ball.eventType === "wide" || ball.eventType === "noball"
    ? `${ball.over}.${ball.ball}*`
    : `${ball.over}.${ball.ball}`;

  return (
    <div className={`flex items-start gap-2 py-1 px-2 rounded sm:gap-3 ${bgClass}`}>
      <span className="text-th-faint text-xs font-mono w-8 flex-shrink-0 pt-0.5">
        {overBall}
      </span>
      {drsVerdict && (
        <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${drsBadgeClass}`}>
          {getDrsVerdictLabel(drsVerdict, ball.commentary)}
        </span>
      )}
      <span className={`min-w-0 flex-1 break-words whitespace-normal text-sm font-mono ${colorClass}`}>
        {ball.commentary}
      </span>
      <span className="text-th-faint text-xs flex-shrink-0 pt-0.5">
        {ball.scoreSoFar}/{ball.wicketsSoFar}
      </span>
    </div>
  );
}

/* ───── Helpers ───── */

interface OverGroup {
  over: number;
  balls: DetailedBallEvent[];
}

function groupByOver(balls: DetailedBallEvent[]): OverGroup[] {
  const map = new Map<number, DetailedBallEvent[]>();
  for (const ball of balls) {
    if (!map.has(ball.over)) map.set(ball.over, []);
    map.get(ball.over)!.push(ball);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([over, balls]) => ({ over, balls }));
}
