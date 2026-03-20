import { useState, useCallback } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { SetupPage } from "./pages/SetupPage";
import { SeasonPage } from "./pages/SeasonPage";
import { ResultsPage } from "./pages/ResultsPage";
import { TeamView } from "./pages/TeamView";
import { PlayerRatingsPage } from "./pages/PlayerRatingsPage";
import {
  GameState,
  createGameState,
  runAuctionPhase,
  runSeasonPhase,
  nextSeason,
  saveState,
  loadState,
  clearState,
} from "./game-state";

export default function App() {
  const [state, setState] = useState<GameState>(() => loadState() ?? createGameState());
  const navigate = useNavigate();

  const update = useCallback((newState: GameState) => {
    setState(newState);
    saveState(newState);
  }, []);

  const handleSelectTeam = (teamId: string) => {
    const s = { ...state, userTeamId: teamId, phase: "auction" as const };
    const afterAuction = runAuctionPhase(s);
    update(afterAuction);
    navigate("/season");
  };

  const handleSimSeason = () => {
    const result = runSeasonPhase(state);
    update(result);
    navigate("/results");
  };

  const handleNextSeason = () => {
    const next = nextSeason(state);
    update(next);
    navigate("/season");
  };

  const handleNewGame = () => {
    clearState();
    const fresh = createGameState();
    update(fresh);
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Top nav */}
      <nav className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-6">
        <h1
          className="text-xl font-bold text-orange-400 cursor-pointer"
          onClick={() => navigate("/")}
        >
          IPL Simulator
        </h1>
        {state.userTeamId && (
          <>
            <button onClick={() => navigate("/season")} className="text-gray-300 hover:text-white text-sm">
              Season
            </button>
            <button onClick={() => navigate("/ratings")} className="text-gray-300 hover:text-white text-sm">
              Ratings
            </button>
            <button onClick={() => navigate(`/team/${state.userTeamId}`)} className="text-gray-300 hover:text-white text-sm">
              My Team
            </button>
          </>
        )}
        <div className="flex-1" />
        <span className="text-gray-500 text-xs">Season {state.seasonNumber}</span>
        <button onClick={handleNewGame} className="text-red-400 hover:text-red-300 text-xs">
          New Game
        </button>
      </nav>

      <Routes>
        <Route path="/" element={
          <SetupPage teams={state.teams} onSelectTeam={handleSelectTeam} />
        } />
        <Route path="/season" element={
          <SeasonPage state={state} onSimSeason={handleSimSeason} />
        } />
        <Route path="/results" element={
          <ResultsPage state={state} onNextSeason={handleNextSeason} />
        } />
        <Route path="/team/:teamId" element={
          <TeamView teams={state.teams} />
        } />
        <Route path="/ratings" element={
          <PlayerRatingsPage teams={state.teams} />
        } />
      </Routes>
    </div>
  );
}
