import { useParams, useNavigate } from "react-router-dom";
import { GameState } from "../game-state";
import { PlayerLink } from "../components/PlayerLink";

interface Props {
  state: GameState;
}

export function MatchDetailPage({ state }: Props) {
  const { matchIndex } = useParams<{ matchIndex: string }>();
  const navigate = useNavigate();
  const idx = parseInt(matchIndex ?? "0", 10);
  const match = state.schedule[idx];
  const teamMap = new Map(state.teams.map(t => [t.id, t]));

  if (!match || !match.result) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <p className="text-th-secondary">Match not found or not yet played.</p>
        <button onClick={() => navigate("/season")} className="mt-4 text-orange-400 hover:text-orange-300 text-sm">
          Back to Season
        </button>
      </div>
    );
  }

  const result = match.result;
  const homeTeam = teamMap.get(result.homeTeamId);
  const awayTeam = teamMap.get(result.awayTeamId);
  const winnerTeam = teamMap.get(result.winnerId ?? "");
  const allPlayers = new Map(state.teams.flatMap(t => t.roster).map(p => [p.id, p]));

  // Determine batting/bowling first based on toss
  const tossWinnerTeam = teamMap.get(result.tossWinner);

  const innings1 = result.innings[0];
  const innings2 = result.innings[1];
  const team1 = teamMap.get(innings1.teamId);
  const team2 = teamMap.get(innings2.teamId);

  const getMatchLabel = () => {
    if (match.type === "group") return `Match ${match.matchNumber}`;
    const labels: Record<string, string> = {
      qualifier1: "Qualifier 1",
      eliminator: "Eliminator",
      qualifier2: "Qualifier 2",
      final: "FINAL",
    };
    return labels[match.type] ?? match.type;
  };

  // Get batting scorecard entries from an innings
  const getBattingCard = (innings: typeof innings1) => {
    // innings.batterStats is either a Map or a plain object (from serialization)
    const entries: [string, { runs: number; balls: number; fours: number; sixes: number; isOut: boolean }][] = [];
    if (innings.batterStats instanceof Map) {
      innings.batterStats.forEach((v, k) => entries.push([k, v]));
    } else if (innings.batterStats && typeof innings.batterStats === "object") {
      Object.entries(innings.batterStats).forEach(([k, v]) => entries.push([k, v as any]));
    }
    return entries
      .filter(([, stat]) => stat.balls > 0 || stat.isOut)
      .sort((a, b) => {
        // Sort by batting order: non-out first, then by runs
        if (a[1].isOut !== b[1].isOut) return a[1].isOut ? 1 : -1;
        return b[1].runs - a[1].runs;
      });
  };

  const getBowlingCard = (innings: typeof innings1) => {
    const entries: [string, { overs: number; balls: number; runs: number; wickets: number; wides: number; noballs: number }][] = [];
    if (innings.bowlerStats instanceof Map) {
      innings.bowlerStats.forEach((v, k) => entries.push([k, v]));
    } else if (innings.bowlerStats && typeof innings.bowlerStats === "object") {
      Object.entries(innings.bowlerStats).forEach(([k, v]) => entries.push([k, v as any]));
    }
    return entries.filter(([, stat]) => stat.overs > 0 || stat.balls > 0);
  };

  const renderInningsScorecard = (
    innings: typeof innings1,
    bowlingInnings: typeof innings1,
    battingTeam: typeof team1,
    bowlingTeam: typeof team1,
    inningsNumber: number,
  ) => {
    const battingCard = getBattingCard(innings);
    const bowlingCard = getBowlingCard(innings);

    return (
      <div className="bg-th-surface rounded-xl border border-th overflow-hidden mb-6">
        {/* Innings header */}
        <div
          className="px-4 py-3 border-b border-th flex items-center justify-between"
          style={{ backgroundColor: battingTeam?.config.primaryColor + "15" }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
              style={{ backgroundColor: battingTeam?.config.primaryColor }}
            >
              {battingTeam?.shortName.slice(0, 2)}
            </div>
            <h3 className="text-th-primary font-semibold text-sm">{battingTeam?.name}</h3>
            <span className="text-th-secondary text-xs">({inningsNumber === 1 ? "1st" : "2nd"} Innings)</span>
          </div>
          <div className="text-right">
            <span className="text-th-primary font-bold text-lg">
              {innings.runs}/{innings.wickets}
            </span>
            <span className="text-th-secondary text-sm ml-2">
              ({innings.overs} ov)
            </span>
          </div>
        </div>

        {/* Batting */}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-th-muted text-xs uppercase bg-th-raised">
              <th scope="col" className="text-left px-4 py-1.5">Batter</th>
              <th scope="col" className="text-center px-3 py-1.5">R</th>
              <th scope="col" className="text-center px-3 py-1.5">B</th>
              <th scope="col" className="text-center px-3 py-1.5">4s</th>
              <th scope="col" className="text-center px-3 py-1.5">6s</th>
              <th scope="col" className="text-center px-3 py-1.5">SR</th>
            </tr>
          </thead>
          <tbody>
            {battingCard.map(([playerId, stat]) => {
              const player = allPlayers.get(playerId);
              const sr = stat.balls > 0 ? (stat.runs / stat.balls) * 100 : 0;
              return (
                <tr key={playerId} className="border-t border-th">
                  <td className="px-4 py-1.5">
                    <PlayerLink playerId={playerId} className="text-th-primary">{player?.name ?? playerId}</PlayerLink>
                    {stat.isOut && <span className="text-red-400 text-xs ml-1">out</span>}
                    {!stat.isOut && stat.balls > 0 && <span className="text-green-400 text-xs ml-1">not out</span>}
                  </td>
                  <td className="text-center px-3 py-1.5 text-th-primary font-medium">{stat.runs}</td>
                  <td className="text-center px-3 py-1.5 text-th-muted">{stat.balls}</td>
                  <td className="text-center px-3 py-1.5 text-th-muted">{stat.fours}</td>
                  <td className="text-center px-3 py-1.5 text-th-muted">{stat.sixes}</td>
                  <td className="text-center px-3 py-1.5 text-th-muted">{sr.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Extras + Total */}
        <div className="px-4 py-2 border-t border-th flex justify-between text-xs text-th-secondary">
          <span>Extras: {innings.extras}</span>
          <span>Fours: {innings.fours} | Sixes: {innings.sixes}</span>
        </div>

        {/* Bowling */}
        <div className="border-t border-th">
          <div className="px-4 py-2 bg-th-raised">
            <span className="text-th-secondary text-xs font-semibold uppercase">Bowling</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-th-muted text-xs uppercase bg-th-raised">
                <th scope="col" className="text-left px-4 py-1.5">Bowler</th>
                <th scope="col" className="text-center px-3 py-1.5">O</th>
                <th scope="col" className="text-center px-3 py-1.5">R</th>
                <th scope="col" className="text-center px-3 py-1.5">W</th>
                <th scope="col" className="text-center px-3 py-1.5">Econ</th>
              </tr>
            </thead>
            <tbody>
              {bowlingCard.map(([playerId, stat]) => {
                const player = allPlayers.get(playerId);
                const totalOvers = stat.overs + stat.balls / 10;
                const oversDisplay = stat.balls > 0 ? `${stat.overs}.${stat.balls}` : `${stat.overs}`;
                const econ = totalOvers > 0 ? stat.runs / (stat.overs + stat.balls / 6) : 0;
                return (
                  <tr key={playerId} className="border-t border-th">
                    <td className="px-4 py-1.5"><PlayerLink playerId={playerId} className="text-th-primary">{player?.name ?? playerId}</PlayerLink></td>
                    <td className="text-center px-3 py-1.5 text-th-secondary">{oversDisplay}</td>
                    <td className="text-center px-3 py-1.5 text-th-secondary">{stat.runs}</td>
                    <td className="text-center px-3 py-1.5 text-th-primary font-medium">{stat.wickets}</td>
                    <td className="text-center px-3 py-1.5 text-th-muted">{econ.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const motmPlayer = allPlayers.get(result.motm);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Back link */}
      <button
        onClick={() => navigate("/season")}
        className="text-th-secondary hover:text-th-primary text-sm mb-6 inline-flex items-center gap-1"
      >
        &larr; Back to Season
      </button>

      {/* Match header */}
      <div className="bg-th-surface rounded-xl border border-th p-6 mb-6">
        <div className="text-center">
          <span className={`text-xs font-semibold uppercase tracking-wider ${
            match.isPlayoff ? "text-yellow-400" : "text-th-muted"
          }`}>
            {getMatchLabel()} — Season {state.seasonNumber}
          </span>
        </div>

        <div className="flex items-center justify-center gap-8 mt-4">
          {/* Home team */}
          <div className="text-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold mx-auto"
              style={{ backgroundColor: homeTeam?.config.primaryColor }}
            >
              {homeTeam?.shortName}
            </div>
            <p className="text-th-primary font-semibold mt-2">{homeTeam?.name}</p>
          </div>

          {/* Score */}
          <div className="text-center">
            <div className="flex items-center gap-4">
              <span className="text-2xl font-bold text-th-primary">
                {innings1.teamId === result.homeTeamId
                  ? `${innings1.runs}/${innings1.wickets}`
                  : `${innings2.runs}/${innings2.wickets}`}
              </span>
              <span className="text-th-muted text-lg">vs</span>
              <span className="text-2xl font-bold text-th-primary">
                {innings1.teamId === result.awayTeamId
                  ? `${innings1.runs}/${innings1.wickets}`
                  : `${innings2.runs}/${innings2.wickets}`}
              </span>
            </div>
            <p className="text-th-secondary text-sm mt-2">
              {winnerTeam?.name} won by {result.margin}
            </p>
          </div>

          {/* Away team */}
          <div className="text-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold mx-auto"
              style={{ backgroundColor: awayTeam?.config.primaryColor }}
            >
              {awayTeam?.shortName}
            </div>
            <p className="text-th-primary font-semibold mt-2">{awayTeam?.name}</p>
          </div>
        </div>

        {/* Toss + MOTM */}
        <div className="flex justify-center gap-8 mt-4 text-xs text-th-secondary">
          <span>Toss: {tossWinnerTeam?.shortName} chose to {result.tossDecision}</span>
          {motmPlayer && (
            <span>
              Player of the Match: <PlayerLink playerId={motmPlayer.id} className="text-yellow-400">{motmPlayer.name}</PlayerLink>
            </span>
          )}
        </div>
      </div>

      {/* Innings scorecards */}
      {renderInningsScorecard(innings1, innings2, team1, team2, 1)}
      {renderInningsScorecard(innings2, innings1, team2, team1, 2)}

      {/* Navigation */}
      <div className="flex justify-between mt-6">
        {idx > 0 && state.schedule[idx - 1]?.result && (
          <button
            onClick={() => navigate(`/match/${idx - 1}`)}
            className="text-th-secondary hover:text-th-primary text-sm"
          >
            &larr; Previous Match
          </button>
        )}
        <div className="flex-1" />
        {idx < state.schedule.length - 1 && state.schedule[idx + 1]?.result && (
          <button
            onClick={() => navigate(`/match/${idx + 1}`)}
            className="text-th-secondary hover:text-th-primary text-sm"
          >
            Next Match &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
