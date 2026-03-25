import { useState, useCallback, useEffect, useRef } from "react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import {
  type RuleSet,
  type MatchState,
  type NarrativeEvent,
  createMatchState,
} from "@ipl-sim/engine";
import { SetupPage } from "./pages/SetupPage";
import { SeasonPage } from "./pages/SeasonPage";
import { ResultsPage } from "./pages/ResultsPage";
import { TeamView } from "./pages/TeamView";
import { PlayerRatingsPage } from "./pages/PlayerRatingsPage";
import { TradePage } from "./pages/TradePage";
import { RetentionPage } from "./pages/RetentionPage";
import { AuctionPage } from "./pages/AuctionPage";
import { SavesPage } from "./pages/SavesPage";
import { MatchPage } from "./pages/MatchPage";
import { MatchDetailPage } from "./pages/MatchDetailPage";
import { PlayerPage } from "./pages/PlayerPage";
import { LineupPage } from "./pages/LineupPage";
import { LiveMatchPage } from "./pages/LiveMatchPage";
import { InboxPage } from "./pages/InboxPage";
import { PowerRankingsPage } from "./pages/PowerRankingsPage";
import { TrainingPage } from "./pages/TrainingPage";
import { LobbyPage } from "./pages/LobbyPage";
import { MultiAuctionPage } from "./pages/MultiAuctionPage";
import { getTeamLogo } from "./team-logos";
import { useTheme } from "./hooks/useTheme";
import {
  GameState,
  createGameState,
  runAuctionPhase,
  runSeasonPhase,
  nextSeason,
  respondToTradeOffer,
  proposeUserTrade,
  finishTrades,
  extendUserPlayerContract,
  releaseExpiredUserContracts,
  initSeason,
  playNextMatch,
  applyLiveMatchToState,
  simToMatch,
  isSeasonComplete,
  isGroupStageComplete,
  finalizeSeason,
  setUserLineup,
  exportSave,
  importSave,
  addPlayersToPool,
  replaceTeamRoster,
  updateStadiumRating,
  listSaveSlots,
  getActiveSlotId,
  setActiveSlotId,
  loadStateFromSlot,
  deleteSaveSlot,
  importCustomPlayers,
  importTeamRoster,
  detectImportType,
  togglePlayerRetention,
  runCPURetentions,
  finishRetention,
  setPlayerTrainingFocus,
  setTeamTrainingIntensity,
  recordPlayerScoutingExposure,
  recordTeamScoutingExposure,
  toggleScoutingAssignment,
  toggleShortlistPlayer,
  toggleWatchlistPlayer,
  initLiveAuction,
  liveAuctionUserBid,
  liveAuctionUserPass,
  liveAuctionCpuRound,
  liveAuctionNextPlayer,
  liveAuctionSimPlayer,
  liveAuctionSimRemaining,
  finalizeLiveAuction,
  promoteYouthProspect,
  type SaveSlotInfo,
} from "./game-state";
import { saveState, loadState, clearState } from "./storage";
import { saveMatchDetail } from "./match-db";

function ThemeToggle({ resolved, toggle }: { resolved: "light" | "dark"; toggle: () => void }) {
  return (
    <button
      onClick={toggle}
      className="p-2 rounded-lg text-th-muted hover:text-th-primary hover:bg-th-hover transition-colors"
      aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
    >
      {resolved === "dark" ? (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}

function MobileNav({ state, navigate, onNewGame, themeResolved, themeToggle }: {
  state: GameState;
  navigate: ReturnType<typeof useNavigate>;
  onNewGame: () => void;
  themeResolved: "light" | "dark";
  themeToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const navLink = (to: string, label: string) => {
    const isActive = location.pathname === to || (to.startsWith("/team/") && location.pathname.startsWith("/team/"));
    return (
      <button
        onClick={() => { navigate(to); setOpen(false); }}
        className={`text-sm py-2 md:py-0 transition-colors relative ${
          isActive
            ? "text-th-primary font-medium"
            : "text-th-secondary hover:text-th-primary"
        }`}
      >
        {label}
        {isActive && (
          <span className="hidden md:block absolute -bottom-[13px] left-0 right-0 h-[2px] bg-gradient-to-r from-orange-400 to-amber-500 rounded-full" />
        )}
      </button>
    );
  };

  return (
    <nav className="glass border-b border-th sticky top-0 z-50">
      <div className="px-4 md:px-6 py-3 flex items-center gap-4 md:gap-8 max-w-7xl mx-auto">
        <h1
          className="text-lg font-bold cursor-pointer tracking-tight flex items-center gap-2"
          onClick={() => navigate("/")}
        >
          {(() => { const logo = state.userTeamId ? getTeamLogo(state.userTeamId) : null; return logo ? (
            <img src={logo} alt="" className="w-6 h-6 object-contain" />
          ) : (
            <span className="text-gradient-orange font-extrabold">
              {state.rules.leagueName ?? (state.rules.league === "wpl" ? "WPL" : "IPL")}
            </span>
          ); })()}
          <span className="text-th-secondary font-medium">Sim</span>
        </h1>

        {/* Desktop nav links */}
        {state.userTeamId && (
          <div className="hidden md:flex items-center gap-6">
            {navLink("/season", "Season")}
            {navLink("/inbox", "Inbox")}
            {navLink("/ratings", "Ratings")}
            {navLink(`/team/${state.userTeamId}`, "My Team")}
            {navLink("/lineup", "Lineup")}
            {navLink("/training", "Training")}
          </div>
        )}

        <div className="flex-1" />

        {state.rules.impactPlayer && (
          <span className="hidden sm:inline text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2.5 py-0.5 font-medium">Impact Player</span>
        )}
        <span className="text-th-muted text-xs font-mono hidden sm:inline">S{state.seasonNumber}</span>

        {/* Desktop actions */}
        <div className="hidden md:flex items-center gap-1">
          {navLink("/saves", "Saves")}
          <ThemeToggle resolved={themeResolved} toggle={themeToggle} />
          <button onClick={onNewGame} className="text-red-400/70 hover:text-red-400 text-xs px-2.5 py-1.5 rounded-md hover:bg-red-500/10 transition-colors ml-2">New Game</button>
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setOpen(!open)}
          className="md:hidden p-2 text-th-secondary hover:text-th-primary rounded-lg hover:bg-th-hover transition-colors"
          aria-label="Toggle menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden border-t border-white/[0.06] px-4 py-3 flex flex-col gap-1 animate-fade-in">
          {state.userTeamId && (
            <>
              {navLink("/season", "Season")}
              {navLink("/inbox", "Inbox")}
              {navLink("/ratings", "Ratings")}
              {navLink(`/team/${state.userTeamId}`, "My Team")}
              {navLink("/training", "Training")}
            </>
          )}
          <div className="border-t border-th mt-2 pt-2 flex flex-col gap-1">
            <span className="text-th-faint text-xs font-mono">Season {state.seasonNumber}</span>
            {navLink("/saves", "Saves & Data")}
            <button onClick={() => { themeToggle(); }} className="text-th-muted hover:text-th-primary text-sm text-left py-1.5 flex items-center gap-2">
              {themeResolved === "dark" ? "Light Mode" : "Dark Mode"}
            </button>
            <button onClick={() => { onNewGame(); setOpen(false); }} className="text-red-400 hover:text-red-300 text-sm text-left py-1.5">New Game</button>
          </div>
        </div>
      )}
    </nav>
  );
}

export default function App() {
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [slots, setSlots] = useState<SaveSlotInfo[]>([]);
  const navigate = useNavigate();
  const location = useLocation();

  // Async load on mount — restore route based on saved game phase
  useEffect(() => {
    loadState().then(saved => {
      const gs = saved ?? createGameState();
      setState(gs);
      setSlots(listSaveSlots());
      setLoading(false);

      // Route restoration: if the URL is just "/" (default) and we have real game state,
      // navigate to the correct page for the current phase.
      // If the URL is already a deep link (e.g. /season, /live-match/5), trust it.
      if (location.pathname === "/" && gs.userTeamId) {
        switch (gs.phase) {
          case "season":
            if (gs.needsLineup) { navigate("/lineup", { replace: true }); }
            else if (gs.schedule.length > 0) { navigate("/season", { replace: true }); }
            break;
          case "auction":
            navigate("/auction-live", { replace: true });
            break;
          case "trade":
            navigate("/trade", { replace: true });
            break;
          case "retention":
            navigate("/retention", { replace: true });
            break;
          case "results":
            navigate("/results", { replace: true });
            break;
        }
      }
    });
  }, []);

  const refreshSlots = useCallback(() => {
    setSlots(listSaveSlots());
  }, []);

  const update = useCallback((newState: GameState) => {
    setState(newState);
    saveState(newState).then(() => refreshSlots()); // async, fire-and-forget
  }, [refreshSlots]);

  // ── Live match state (must be before early return to maintain hook order) ──
  const [liveMatchState, setLiveMatchState] = useState<MatchState | null>(null);
  const liveMatchIndex = useRef<number>(-1);

  const { resolved: themeResolved, toggle: themeToggle } = useTheme();

  /** Called when a live match completes. Uses the actual live match result (no re-simulation). */
  const handleLiveMatchComplete = useCallback((completedMatchState: MatchState, matchIdx?: number, narrativeEvents?: NarrativeEvent[]) => {
    setState(prev => {
      if (!prev) return prev;
      const idx = matchIdx ?? liveMatchIndex.current;
      if (idx < 0) return prev;
      // Apply the live match result directly — no re-simulation
      const { state: newState } = applyLiveMatchToState(prev, completedMatchState, narrativeEvents);
      setLiveMatchState(null);
      liveMatchIndex.current = -1;
      // Fire-and-forget save
      saveState(newState).then(() => refreshSlots());
      return newState;
    });
  }, [refreshSlots]);

  if (loading || !state) {
    return (
      <div className="min-h-screen bg-th-body flex items-center justify-center noise">
        <div className="text-center animate-pulse">
          <div className="text-3xl font-display font-extrabold text-gradient-orange mb-2">IPL Sim</div>
          <p className="text-th-muted text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  const handleRulesChange = (rules: RuleSet) => {
    clearState();
    const fresh = createGameState(rules);
    update(fresh);
  };

  const handleSelectTeam = (teamId: string) => {
    // If teams already have full rosters (real players loaded), skip auction
    const minSquad = state.rules.maxSquadSize >= 18 ? 18 : 11;
    const allTeamsStaffed = state.teams.every(t => t.roster.length >= minSquad);
    if (allTeamsStaffed) {
      // Skip straight to season — no auction needed
      const s = { ...state, userTeamId: teamId, phase: "season" as const };
      const userTeam = s.teams.find(t => t.id === teamId);
      if (userTeam) userTeam.isUserControlled = true;
      const afterInit = initSeason(s);
      update(afterInit);
      if (afterInit.needsLineup) {
        navigate("/lineup");
      } else {
        navigate("/season");
      }
      return;
    }
    const s = { ...state, userTeamId: teamId, phase: "auction" as const };
    const withAuction = initLiveAuction(s);
    update(withAuction);
    navigate("/auction-live");
  };

  const handleSimSeason = () => {
    const result = runSeasonPhase(state);
    update(result);
    navigate("/results");
  };

  // ── Match-by-match handlers ──

  const handleStartMatchBased = () => {
    const afterInit = initSeason(state);
    update(afterInit);
    if (afterInit.needsLineup) {
      navigate("/lineup");
    }
  };

  const handlePlayNextMatch = () => {
    if (state.currentMatchIndex >= state.schedule.length) return;
    const matchIdx = state.currentMatchIndex;
    const match = state.schedule[matchIdx];
    const homeTeam = state.teams.find(t => t.id === match.homeTeamId);
    const awayTeam = state.teams.find(t => t.id === match.awayTeamId);

    if (!homeTeam || !awayTeam) return;

    // Create the incremental match state
    // Pass userTeamId so the engine knows which team to pause for decisions
    const isUserMatch = state.userTeamId && (match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId);
    const ms = createMatchState(homeTeam, awayTeam, state.rules, isUserMatch ? state.userTeamId : null);
    setLiveMatchState(ms);
    liveMatchIndex.current = matchIdx;
    navigate(`/live-match/${matchIdx}`);
  };

  const handleSimBatch = (count: number) => {
    const target = Math.min(state.currentMatchIndex + count, state.schedule.length);
    const { state: newState, detailedResults } = simToMatch(state, target);
    update(newState);
    // Persist all detailed results to IndexedDB (fire-and-forget)
    for (const { matchIndex, detail } of detailedResults) {
      saveMatchDetail(state.seasonNumber, matchIndex, detail);
    }
    if (newState.needsLineup) {
      navigate("/lineup");
    }
  };

  const handleSimToPlayoffs = () => {
    const groupCount = state.schedule.filter(m => m.type === "group").length;
    const { state: newState, detailedResults } = simToMatch(state, groupCount);
    update(newState);
    // Persist all detailed results to IndexedDB (fire-and-forget)
    for (const { matchIndex, detail } of detailedResults) {
      saveMatchDetail(state.seasonNumber, matchIndex, detail);
    }
    if (newState.needsLineup) {
      navigate("/lineup");
    }
  };

  const handleViewResults = () => {
    const finalState = finalizeSeason(state);
    update(finalState);
    navigate("/results");
  };

  const handleConfirmLineup = (xiIds: string[], battingOrder: string[], bowlingOrder: string[], bowlingPlan?: import("@ipl-sim/engine").BowlingPlan) => {
    const afterLineup = setUserLineup(state, xiIds, battingOrder, bowlingOrder, bowlingPlan);
    update(afterLineup);

    // Navigate to live match for user's team match
    const matchIdx = afterLineup.currentMatchIndex;
    const match = afterLineup.schedule[matchIdx];
    if (!match) { navigate("/season"); return; }

    const homeTeam = afterLineup.teams.find(t => t.id === match.homeTeamId);
    const awayTeam = afterLineup.teams.find(t => t.id === match.awayTeamId);
    if (!homeTeam || !awayTeam) { navigate("/season"); return; }

    const isUserMatch = afterLineup.userTeamId && (match.homeTeamId === afterLineup.userTeamId || match.awayTeamId === afterLineup.userTeamId);
    const ms = createMatchState(homeTeam, awayTeam, afterLineup.rules, isUserMatch ? afterLineup.userTeamId : null);
    setLiveMatchState(ms);
    liveMatchIndex.current = matchIdx;
    navigate(`/live-match/${matchIdx}`);
  };

  const handleNextSeason = () => {
    const next = nextSeason(state);
    update(next);
    navigate("/trade");
  };

  const handleRespondToOffer = (offerId: string, accept: boolean) => {
    const next = respondToTradeOffer(state, offerId, accept);
    update(next);
  };

  const handleProposeTrade = (toTeamId: string, userPlayerIds: string[], targetPlayerIds: string[]) => {
    const { state: nextState, accepted, reason, counterOffer } = proposeUserTrade(state, toTeamId, userPlayerIds, targetPlayerIds);
    update(nextState);
    return { accepted, reason, counterOffer };
  };

  const handleFinishTrades = () => {
    const next = finishTrades(state);
    update(next);
    navigate("/retention");
  };

  const handleExtendContract = (playerId: string, years: number) => {
    update(extendUserPlayerContract(state, playerId, years));
  };

  const handleReleaseExpiredContracts = () => {
    update(releaseExpiredUserContracts(state));
  };

  // ── Retention handlers ──

  const handleToggleRetention = (playerId: string) => {
    const next = togglePlayerRetention(state, playerId);
    update(next);
  };

  const handleRunCPURetentions = () => {
    const next = runCPURetentions(state);
    update(next);
  };

  const handleFinishRetention = () => {
    const retainedState = finishRetention(state);
    const withAuction = initLiveAuction(retainedState);
    update(withAuction);
    navigate("/auction-live");
  };

  const handleSetPlayerTrainingFocus = (playerId: string, focus: import("@ipl-sim/engine").TrainingFocus) => {
    update(setPlayerTrainingFocus(state, playerId, focus));
  };

  const handleSetTeamTrainingIntensity = (teamId: string, intensity: import("@ipl-sim/engine").TrainingIntensity) => {
    update(setTeamTrainingIntensity(state, teamId, intensity));
  };

  const handleScoutPlayers = (playerIds: string[], amount = 8) => {
    if (playerIds.length === 0) return;
    update(recordPlayerScoutingExposure(state, playerIds, amount));
  };

  const handleScoutTeam = (teamId: string, amount = 8) => {
    update(recordTeamScoutingExposure(state, teamId, amount));
  };

  const handleTogglePlayerScoutAssignment = (playerId: string) => {
    update(toggleScoutingAssignment(state, "player", playerId));
  };

  const handleToggleShortlistScoutAssignment = () => {
    update(toggleScoutingAssignment(state, "shortlist"));
  };

  const handleToggleMarketScoutAssignment = () => {
    update(toggleScoutingAssignment(state, "market"));
  };

  const handleToggleShortlist = (playerId: string) => {
    update(toggleShortlistPlayer(state, playerId));
  };

  const handleToggleWatchlist = (playerId: string) => {
    update(toggleWatchlistPlayer(state, playerId));
  };

  // ── Live Auction handlers ──

  const handleAuctionUserBid = () => {
    const next = liveAuctionUserBid(state);
    update(next);
  };

  const handleAuctionUserPass = () => {
    const next = liveAuctionUserPass(state);
    update(next);
  };

  const handleAuctionCpuRound = () => {
    const next = liveAuctionCpuRound(state);
    update(next);
  };

  const handleAuctionNextPlayer = () => {
    const next = liveAuctionNextPlayer(state);
    update(next);
  };

  const handleAuctionSimPlayer = () => {
    const next = liveAuctionSimPlayer(state);
    update(next);
  };

  const handleAuctionSimRemaining = () => {
    const next = liveAuctionSimRemaining(state);
    update(next);
  };

  const handleAuctionFinish = () => {
    const next = finalizeLiveAuction(state);
    const afterInit = initSeason(next);
    update(afterInit);
    if (afterInit.needsLineup) {
      navigate("/lineup");
    } else {
      navigate("/season");
    }
  };

  const handleUpdateStadium = (rating: number) => {
    if (!state.userTeamId) return;
    const next = updateStadiumRating(state, state.userTeamId, rating);
    update(next);
  };

  const handlePromoteProspect = (index: number) => {
    const next = promoteYouthProspect(state, index);
    update(next);
  };

  const handleNewGame = () => {
    // Don't delete the active slot — just deactivate it
    setActiveSlotId(null);
    const fresh = createGameState(state.rules);
    setState(fresh);
    refreshSlots();
    navigate("/");
  };

  const handleExport = () => {
    exportSave(state);
  };

  const handleLoadSlot = async (slotId: string) => {
    const loaded = await loadStateFromSlot(slotId);
    if (loaded) {
      setActiveSlotId(slotId);
      setState(loaded);
      refreshSlots();
      navigate(loaded.userTeamId ? "/season" : "/");
    }
  };

  const handleDeleteSlot = async (slotId: string) => {
    await deleteSaveSlot(slotId);
    refreshSlots();
    // If we deleted the active slot, reset to a fresh game
    if (getActiveSlotId() === null) {
      const fresh = createGameState();
      setState(fresh);
      navigate("/");
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const fileType = await detectImportType(file);

      if (fileType === "full-save") {
        const imported = await importSave(file);
        setState(imported);
        refreshSlots();
        navigate("/");
      } else if (fileType === "player-ratings") {
        const players = await importCustomPlayers(file);
        const next = addPlayersToPool(state, players);
        update(next);
        alert(`Imported ${players.length} players into the auction pool.`);
      } else if (fileType === "team-roster") {
        const { config, players, totalSpent } = await importTeamRoster(file);
        const targetTeam = state.teams.find(t => t.id === config.id);
        if (!targetTeam) {
          alert(`Team "${config.name}" (${config.id}) not found in the current game.`);
          return;
        }
        if (!confirm(`Replace ${targetTeam.name}'s roster with ${players.length} imported players?`)) {
          return;
        }
        const next = replaceTeamRoster(state, config.id, players, totalSpent);
        update(next);
        alert(`Imported roster for ${targetTeam.name} (${players.length} players).`);
      } else {
        alert("Unrecognized file format. Expected a full save, player ratings, or team roster file.");
      }
    } catch (err: any) {
      alert(err?.message ?? "Failed to import file");
    }
  };

  return (
    <div className="min-h-screen bg-th-body noise transition-colors">
      {/* Top nav */}
      <MobileNav
        state={state}
        navigate={navigate}
        onNewGame={handleNewGame}
        themeResolved={themeResolved}
        themeToggle={themeToggle}
      />

      <Routes>
        <Route path="/" element={
          <SetupPage
            teams={state.teams}
            rules={state.rules}
            onRulesChange={handleRulesChange}
            onSelectTeam={handleSelectTeam}
            slots={slots}
            onLoadSlot={handleLoadSlot}
          />
        } />
        <Route path="/season" element={
          <SeasonPage
            state={state}
            onSimSeason={handleSimSeason}
            onStartMatchBased={handleStartMatchBased}
            onPlayNextMatch={handlePlayNextMatch}
            onSimBatch={handleSimBatch}
            onSimToPlayoffs={handleSimToPlayoffs}
            onViewResults={handleViewResults}
            onPromoteProspect={handlePromoteProspect}
          />
        } />
        <Route path="/inbox" element={<InboxPage state={state} />} />
        <Route path="/results" element={
          <ResultsPage state={state} onNextSeason={handleNextSeason} />
        } />
        <Route path="/trade" element={
          <TradePage
            state={state}
            scouting={state.scouting}
            recruitment={state.recruitment}
            onExtendContract={handleExtendContract}
            onReleaseExpiredContracts={handleReleaseExpiredContracts}
            onRespondToOffer={handleRespondToOffer}
            onProposeTrade={handleProposeTrade}
            onFinishTrades={handleFinishTrades}
            onUpdateStadium={handleUpdateStadium}
            onScoutTeam={handleScoutTeam}
            onScoutPlayers={handleScoutPlayers}
            onPromoteProspect={handlePromoteProspect}
          />
        } />
        <Route path="/retention" element={
          <RetentionPage
            state={state}
            onToggleRetention={handleToggleRetention}
            onRunCPURetentions={handleRunCPURetentions}
            onFinishRetention={handleFinishRetention}
          />
        } />
        <Route path="/auction-live" element={
          <AuctionPage
            state={state}
            scouting={state.scouting}
            recruitment={state.recruitment}
            onUserBid={handleAuctionUserBid}
            onUserPass={handleAuctionUserPass}
            onCpuRound={handleAuctionCpuRound}
            onNextPlayer={handleAuctionNextPlayer}
            onSimPlayer={handleAuctionSimPlayer}
            onSimRemaining={handleAuctionSimRemaining}
            onFinishAuction={handleAuctionFinish}
            onScoutPlayers={handleScoutPlayers}
            onToggleShortlist={handleToggleShortlist}
            onToggleWatchlist={handleToggleWatchlist}
          />
        } />
        <Route path="/team/:teamId" element={
          <TeamView
            teams={state.teams}
            rules={state.rules}
            scouting={state.scouting}
            recruitment={state.recruitment}
            userTeamId={state.userTeamId}
            onScoutTeam={handleScoutTeam}
          />
        } />
        <Route path="/ratings" element={
          <PlayerRatingsPage
            teams={state.teams}
            playerPool={state.playerPool}
            scouting={state.scouting}
            scoutingAssignments={state.scoutingAssignments}
            userTeamId={state.userTeamId}
            recruitment={state.recruitment}
            onTogglePlayerAssignment={handleTogglePlayerScoutAssignment}
            onToggleShortlistAssignment={handleToggleShortlistScoutAssignment}
            onToggleMarketAssignment={handleToggleMarketScoutAssignment}
            onToggleShortlist={handleToggleShortlist}
            onToggleWatchlist={handleToggleWatchlist}
          />
        } />
        <Route path="/player/:playerId" element={
          <PlayerPage
            state={state}
            onScoutPlayer={playerId => handleScoutPlayers([playerId], 12)}
            onToggleScoutAssignment={handleTogglePlayerScoutAssignment}
            onToggleShortlist={handleToggleShortlist}
            onToggleWatchlist={handleToggleWatchlist}
          />
        } />
        <Route path="/match/:matchIndex" element={
          <MatchPage state={state} />
        } />
        <Route path="/live-match/:matchIndex" element={
          <LiveMatchPage
            seasonNumber={state.seasonNumber}
            matchState={liveMatchState}
            matchIndex={liveMatchIndex.current}
            onMatchComplete={handleLiveMatchComplete}
            userTeamId={state.userTeamId}
            teams={state.teams}
            previousResults={state.matchResults}
          />
        } />
        <Route path="/power-rankings" element={
          <PowerRankingsPage teams={state.teams} />
        } />
        <Route path="/lineup" element={
          (() => {
            const userTeam = state.teams.find(t => t.id === state.userTeamId);
            return userTeam ? (
              <LineupPage
                team={userTeam}
                onConfirm={handleConfirmLineup}
              />
            ) : (
              <div className="p-8 text-th-secondary">No team selected</div>
            );
          })()
        } />
        <Route path="/training" element={
          <TrainingPage
            state={state}
            onSetPlayerFocus={handleSetPlayerTrainingFocus}
            onSetIntensity={handleSetTeamTrainingIntensity}
          />
        } />
        <Route path="/saves" element={
          <SavesPage
            state={state}
            slots={slots}
            activeSlotId={getActiveSlotId()}
            onLoadSlot={handleLoadSlot}
            onDeleteSlot={handleDeleteSlot}
            onExport={handleExport}
            onImportFile={handleImportFile}
            onNewGame={handleNewGame}
          />
        } />
        <Route path="/multiplayer" element={<LobbyPage />} />
        <Route path="/multiplayer/auction" element={<MultiAuctionPage />} />
      </Routes>
    </div>
  );
}
