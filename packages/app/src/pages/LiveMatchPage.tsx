import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type MatchState,
  type DetailedBallEvent,
  type PendingDecisionOption,
  type FieldSetting,
  stepBall,
  startSecondInnings,
  simulateRemaining,
  buildDetailedResultFromState,
  deserializeMatchState,
  serializeMatchState,
  applyDecision,
  autoResolveDecision,
  getImpactSubOptions,
  applyImpactSub,
  setAggression,
  setFieldSetting,
  calculateWinProbability,
  type NarrativeEvent,
} from "@ipl-sim/engine";
import {
  saveInProgressMatch,
  clearInProgressMatch,
  getInProgressMatch,
  saveMatchDetail,
} from "../match-db";
import { buildNarrativeEventsForLiveState, type FeedMatchResult } from "../news-feed";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { TeamBadge } from "../components/TeamBadge";
import { ovrBgClass } from "../ui-utils";

type Speed = "1x" | "2x" | "5x" | "instant";

const SPEED_DELAYS: Record<Speed, number> = {
  "1x": 1000,
  "2x": 500,
  "5x": 200,
  "instant": 0,
};

type ScorecardTab = "batting" | "bowling" | "fow";

interface Props {
  seasonNumber: number;
  matchState: MatchState | null;
  matchIndex: number;
  onMatchComplete: (matchState: MatchState, matchIndex?: number, narrativeEvents?: NarrativeEvent[]) => void;
  userTeamId: string | null;
  teams?: import("@ipl-sim/engine").Team[];
  previousResults?: FeedMatchResult[];
}

function getStadiumLabel(rating: number): string {
  if (rating <= 0.80) return "Batting Paradise";
  if (rating <= 0.95) return "Batting-Friendly";
  if (rating <= 1.00) return "Neutral";
  if (rating <= 1.15) return "Bowling-Friendly";
  return "Bowling Paradise";
}

export function LiveMatchPage({
  seasonNumber,
  matchState: initialState,
  matchIndex: matchIndexProp,
  onMatchComplete,
  userTeamId,
  teams,
  previousResults = [],
}: Props) {
  const navigate = useNavigate();
  const params = useParams<{ matchIndex: string }>();
  // Use prop if valid, otherwise fall back to URL param (for page refresh)
  const matchIndex = matchIndexProp >= 0 ? matchIndexProp : parseInt(params.matchIndex ?? "-1", 10);
  const [state, setState] = useState<MatchState | null>(initialState);
  const [loading, setLoading] = useState(!initialState);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>("1x");
  const [recentBalls, setRecentBalls] = useState<DetailedBallEvent[]>([]);
  const [flashType, setFlashType] = useState<"four" | "six" | "wicket" | null>(null);
  const [showInningsBreak, setShowInningsBreak] = useState(false);
  const [matchComplete, setMatchComplete] = useState(false);
  const [scorecardTab, setScorecardTab] = useState<ScorecardTab>("batting");
  const [scorecardOpen, setScorecardOpen] = useState(false);
  const [narrativeEvents, setNarrativeEvents] = useState<NarrativeEvent[]>([]);

  // Impact sub state
  const [showImpactSubModal, setShowImpactSubModal] = useState(false);
  const [impactSubIn, setImpactSubIn] = useState<string | null>(null);
  const [impactSubOut, setImpactSubOut] = useState<string | null>(null);

  // DRS result flash
  const [drsResult, setDrsResult] = useState<{ success: boolean; message: string } | null>(null);

  // Pre-match buildup
  const [showBuildup, setShowBuildup] = useState(true);

  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const stateRef = useRef(state);
  const ballFeedRef = useRef<HTMLDivElement>(null);
  const ballsSinceLastSave = useRef(0);

  // Keep refs in sync
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Determine if user's team is in this match
  const isUserMatch = Boolean(
    userTeamId && state && (state.homeTeam.id === userTeamId || state.awayTeam.id === userTeamId)
  );

  // Build player imageUrl lookup from teams prop (since SerializedPlayer in MatchState doesn't carry imageUrl)
  const playerImageMap = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    if (teams) {
      for (const t of teams) {
        for (const p of t.roster) {
          if (p.imageUrl) map[p.id] = p.imageUrl;
        }
      }
    }
    return map;
  }, [teams]);

  // Load from IndexedDB if resuming (e.g. page refresh during live match)
  useEffect(() => {
    if (initialState) return;
    if (matchIndex < 0) { setLoading(false); return; }
    (async () => {
      const saved = await getInProgressMatch(seasonNumber, matchIndex);
      if (saved) {
        const resumed = deserializeMatchState(saved);
        setState(resumed);
        const balls = resumed.innings === 2 ? resumed.innings2BallLog : resumed.innings1BallLog;
        setRecentBalls(balls.slice(-30));
        if (resumed.status === "innings_break") {
          setShowInningsBreak(true);
        }
      }
      setLoading(false);
    })();
  }, [initialState, seasonNumber, matchIndex]);

  // Auto-save after every over
  const autoSave = useCallback(async (currentState: MatchState) => {
    const serialized = serializeMatchState(currentState);
    await saveInProgressMatch(seasonNumber, matchIndex, serialized);
    ballsSinceLastSave.current = 0;
  }, [seasonNumber, matchIndex]);

  // Save on tab visibility change (user switching away) and before page unload (refresh)
  useEffect(() => {
    const saveNow = () => {
      if (stateRef.current && matchIndex >= 0 && stateRef.current.status !== "completed") {
        const serialized = serializeMatchState(stateRef.current);
        saveInProgressMatch(seasonNumber, matchIndex, serialized);
      }
    };
    const handleVisibility = () => { if (document.hidden) saveNow(); };
    const handleUnload = () => saveNow();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [seasonNumber, matchIndex]);

  // Scroll ball feed to bottom
  useEffect(() => {
    if (ballFeedRef.current) {
      ballFeedRef.current.scrollTop = ballFeedRef.current.scrollHeight;
    }
  }, [recentBalls]);

  // Step one ball and update state
  const doStepBall = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) return null;

    // If waiting for a decision, don't step
    if (currentState.status === "waiting_for_decision") {
      // If it's the user's team decision, pause playback
      if (isUserMatch) {
        setPlaying(false);
        return null;
      }
      // CPU decision - auto-resolve
      const resolved = autoResolveDecision(currentState);
      setState(resolved);
      return null;
    }

    if (currentState.status !== "in_progress") return null;

    const { state: newState, ball } = stepBall(currentState);

    setState(newState);
    setRecentBalls(prev => [...prev.slice(-99), ball]);
    ballsSinceLastSave.current++;

    // Flash animation
    if (ball.eventType === "four" || ball.eventType === "six") {
      setFlashType(ball.eventType === "four" ? "four" : "six");
      setTimeout(() => setFlashType(null), 400);
    } else if (ball.eventType === "wicket") {
      setFlashType("wicket");
      setTimeout(() => setFlashType(null), 600);
    }

    // Check for over boundary -> auto-save
    if (newState.balls === 0 && newState.overs > 0 && newState.status === "in_progress") {
      autoSave(newState);
    }

    // Waiting for decision (user's team)
    if (newState.status === "waiting_for_decision") {
      if (isUserMatch) {
        setPlaying(false);
        autoSave(newState);
        return ball;
      }
      // CPU - auto resolve
      const resolved = autoResolveDecision(newState);
      setState(resolved);
      return ball;
    }

    // Innings break
    if (newState.status === "innings_break") {
      setPlaying(false);
      setShowInningsBreak(true);
      // Check for impact sub at innings break
      if (isUserMatch && userTeamId) {
        const impactOpts = getImpactSubOptions(newState, userTeamId);
        if (impactOpts && impactOpts.benchPlayers.length > 0) {
          setShowImpactSubModal(true);
        }
      }
      autoSave(newState);
      return ball;
    }

    // Match complete
    if (newState.status === "completed") {
      setPlaying(false);
      setMatchComplete(true);
      handleMatchComplete(newState);
      return ball;
    }

    return ball;
  }, [autoSave, isUserMatch, userTeamId]);

  // Play/pause loop
  useEffect(() => {
    if (!playing) return;

    // For "instant" speed, use simulateRemaining directly
    if (speedRef.current === "instant") {
      const currentState = stateRef.current;
      if (!currentState) return;

      // If waiting for user decision, don't instant-sim
      if (currentState.status === "waiting_for_decision" && isUserMatch) {
        setPlaying(false);
        return;
      }

      if (currentState.status === "in_progress" || currentState.status === "waiting_for_decision") {
        const { state: completed, balls } = simulateRemaining(currentState);
        setState(completed);
        setRecentBalls(prev => [...prev.slice(-30), ...balls.slice(-30)]);
        setPlaying(false);
        if (completed.status === "innings_break") {
          setShowInningsBreak(true);
          if (isUserMatch && userTeamId) {
            const impactOpts = getImpactSubOptions(completed, userTeamId);
            if (impactOpts && impactOpts.benchPlayers.length > 0) {
              setShowImpactSubModal(true);
            }
          }
          autoSave(completed);
        } else if (completed.status === "completed") {
          setMatchComplete(true);
          handleMatchComplete(completed);
        }
      }
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      if (!playingRef.current) return;
      const ball = doStepBall();
      if (!ball) {
        // Might be waiting for decision
        const s = stateRef.current;
        if (s && s.status === "waiting_for_decision" && isUserMatch) {
          setPlaying(false);
          return;
        }
        if (!ball && s && (s.status === "in_progress" || s.status === "waiting_for_decision")) {
          // CPU decision was auto-resolved, continue
          const delay = SPEED_DELAYS[speedRef.current];
          timer = setTimeout(loop, delay > 0 ? delay : 0);
          return;
        }
        setPlaying(false);
        return;
      }
      if (!playingRef.current) return;

      const delay = SPEED_DELAYS[speedRef.current];
      if (delay > 0) {
        timer = setTimeout(loop, delay);
      } else {
        timer = setTimeout(loop, 0);
      }
    };

    const delay = SPEED_DELAYS[speedRef.current];
    timer = setTimeout(loop, delay > 0 ? delay : 0);

    return () => clearTimeout(timer);
  }, [playing, speed, doStepBall, autoSave, isUserMatch, userTeamId]);

  // Keyboard shortcut: spacebar to play/pause
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target instanceof HTMLElement) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") {
          e.preventDefault();
          togglePlay();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const togglePlay = useCallback(() => {
    if (!state) return;
    if (state.status === "waiting_for_decision") return; // can't play while decision pending
    if (state.status !== "in_progress") return;
    setPlaying(prev => !prev);
  }, [state]);

  // Handle tactical decisions
  const handleDecision = useCallback((type: string, selectedPlayerId: string, swapOutPlayerId?: string) => {
    if (!state || state.status !== "waiting_for_decision") return;

    // For DRS review, capture the result before and after to show flash
    const preDrsWickets = state.wickets;
    const newState = applyDecision(state, { type, selectedPlayerId, swapOutPlayerId });

    if (type === "drs_review" && selectedPlayerId === "review") {
      const overturned = newState.wickets > preDrsWickets;
      setDrsResult({
        success: overturned,
        message: overturned ? "OVERTURNED! Batter is OUT!" : "Umpire's Call -- Review Lost",
      });
      setTimeout(() => setDrsResult(null), 2500);
    }

    setState(newState);
    autoSave(newState);
  }, [state, autoSave]);

  // Start 2nd innings
  const handleStartSecondInnings = useCallback(() => {
    if (!state || state.status !== "innings_break") return;
    const newState = startSecondInnings(state);
    setState(newState);
    setShowInningsBreak(false);
    setShowImpactSubModal(false);
    setRecentBalls([]);
    autoSave(newState);
  }, [state, autoSave]);

  // Apply impact sub
  const handleApplyImpactSub = useCallback(() => {
    if (!state || !userTeamId) return;
    if (impactSubIn && impactSubOut) {
      const newState = applyImpactSub(state, userTeamId, impactSubIn, impactSubOut);
      setState(newState);
      autoSave(newState);
    }
    setShowImpactSubModal(false);
    setImpactSubIn(null);
    setImpactSubOut(null);
  }, [state, userTeamId, impactSubIn, impactSubOut, autoSave]);

  const handleSkipImpactSub = useCallback(() => {
    setShowImpactSubModal(false);
    setImpactSubIn(null);
    setImpactSubOut(null);
  }, []);

  // Sim rest
  const handleSimRest = useCallback(() => {
    if (!state) return;
    setPlaying(false);
    setShowInningsBreak(false);
    setShowImpactSubModal(false);
    const { state: completed } = simulateRemaining(state);
    setState(completed);
    setMatchComplete(true);
    const allBalls = completed.innings === 2 ? completed.innings2BallLog : completed.ballLog;
    setRecentBalls(allBalls.slice(-30));
    handleMatchComplete(completed);
  }, [state]);

  // Handle match completion
  const handleMatchComplete = async (completedState: MatchState) => {
    let generatedEvents: NarrativeEvent[] | undefined;

    try {
      const detailed = buildDetailedResultFromState(completedState);
      await saveMatchDetail(seasonNumber, matchIndex, detailed);
    } catch (err) {
      console.warn("[LiveMatch] Failed to save detailed result:", err);
    }

    // Generate post-match narrative events
    try {
      const events = teams ? buildNarrativeEventsForLiveState({
        state: completedState,
        teams,
        userTeamId,
        recentResults: [
          ...previousResults,
          {
            winnerId: completedState.winnerId ?? null,
            innings: [
              { teamId: completedState.homeTeam.id },
              { teamId: completedState.awayTeam.id },
            ],
          },
        ],
      }) : [];
      setNarrativeEvents(events);
      generatedEvents = events;
    } catch (err) {
      console.warn("[LiveMatch] Failed to generate narrative:", err);
    }

    await clearInProgressMatch(seasonNumber, matchIndex);
    onMatchComplete(completedState, matchIndex, generatedEvents);
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="rounded-2xl border border-white/[0.06] bg-gray-900/50 p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <div className="h-8 w-32 bg-gray-800 rounded animate-pulse" />
            <div className="h-6 w-20 bg-gray-800 rounded animate-pulse" />
            <div className="h-8 w-32 bg-gray-800 rounded animate-pulse" />
          </div>
          <div className="h-12 w-48 mx-auto bg-gray-800 rounded animate-pulse mb-4" />
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-5 bg-gray-800/50 rounded" style={{ width: `${70 + Math.random() * 30}%` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-center text-th-muted">
          <p>No match data found.</p>
          <button onClick={() => navigate("/season")} className="mt-4 btn-primary">
            Back to Season
          </button>
        </div>
      </div>
    );
  }

  const battingTeam = state.battingTeamId === state.homeTeam.id ? state.homeTeam : state.awayTeam;
  const bowlingTeam = state.bowlingTeamId === state.homeTeam.id ? state.homeTeam : state.awayTeam;

  const oversDisplay = state.balls > 0 ? `${state.overs}.${state.balls}` : `${state.overs}.0`;
  const currentRunRate = state.overs > 0 || state.balls > 0
    ? (state.score / (state.overs * 6 + state.balls) * 6).toFixed(2)
    : "0.00";

  let requiredRunRate = "";
  let runsNeeded = 0;
  let ballsLeft = 0;
  if (state.innings === 2 && state.target) {
    runsNeeded = state.target - state.score;
    ballsLeft = (20 - state.overs) * 6 - state.balls;
    if (ballsLeft > 0 && runsNeeded > 0) {
      requiredRunRate = ((runsNeeded / ballsLeft) * 6).toFixed(2);
    }
  }

  const totalBallsInMatch = state.innings === 1
    ? state.overs * 6 + state.balls
    : 120 + state.overs * 6 + state.balls;
  const progressPercent = (totalBallsInMatch / 240) * 100;

  // Build "yet to bat" list
  const battedIds = new Set(state.batterStats.map(b => b.playerId));
  const yetToBat = state._internal.battingOrderIds
    .filter(id => !battedIds.has(id))
    .map(id => state._internal.playerDataMap[id])
    .filter(Boolean);

  const hasPendingDecision = state.status === "waiting_for_decision" && state.pendingDecision;
  const isDecisionForUser = hasPendingDecision && isUserMatch;

  // Pre-match buildup: show when no balls bowled yet and not dismissed
  const noBallsBowled = recentBalls.length === 0 && state.overs === 0 && state.balls === 0 && state.innings === 1;
  const showBuildupScreen = showBuildup && noBallsBowled && state.status === "in_progress";

  if (showBuildupScreen) {
    const homeTeamFull = teams?.find(t => t.id === state.homeTeam.id);
    const awayTeamFull = teams?.find(t => t.id === state.awayTeam.id);
    const pitchType = state._internal.pitchType ?? "balanced";
    const boundarySize = state._internal.boundarySize ?? "medium";
    const dewFactor = state._internal.dewFactor ?? "none";
    const stadiumName = homeTeamFull?.config.stadiumName ?? `${homeTeamFull?.config.city ?? "Unknown"} Stadium`;
    const city = homeTeamFull?.config.city ?? "Unknown";
    const stadiumRating = homeTeamFull?.config.stadiumBowlingRating ?? 1.0;

    // Find highest OVR player from each team
    const homeStarPlayer = homeTeamFull?.roster
      .slice()
      .sort((a, b) => b.overall - a.overall)[0] ?? null;
    const awayStarPlayer = awayTeamFull?.roster
      .slice()
      .sort((a, b) => b.overall - a.overall)[0] ?? null;

    const tossWinnerTeam = state.tossWinner === state.homeTeam.id ? state.homeTeam : state.awayTeam;

    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
        {/* Buildup card with gradient */}
        <div
          className="rounded-2xl border border-th overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${state.homeTeam.primaryColor}18 0%, transparent 40%, ${state.awayTeam.primaryColor}18 100%)`,
          }}
        >
          {/* Top accent bar */}
          <div className="h-1 flex">
            <div className="flex-1" style={{ background: state.homeTeam.primaryColor }} />
            <div className="flex-1" style={{ background: state.awayTeam.primaryColor }} />
          </div>

          <div className="p-5 sm:p-8">
            {/* Match header */}
            <div className="text-center mb-6">
              <div className="text-[10px] text-th-muted uppercase tracking-widest font-display mb-1">
                Match {matchIndex + 1} -- Season {seasonNumber}
              </div>
              <div className="text-xs text-th-faint font-display">IPL {new Date().getFullYear()}</div>
            </div>

            {/* Team vs Team */}
            <div className="flex items-center justify-center gap-6 sm:gap-10 mb-8">
              <div className="text-center">
                <TeamBadge teamId={state.homeTeam.id} shortName={state.homeTeam.shortName} primaryColor={state.homeTeam.primaryColor} size="lg" />
                <div className="mt-2 font-display font-bold text-th-primary text-sm sm:text-base">{state.homeTeam.shortName}</div>
                <div className="text-[10px] text-th-muted font-display">{state.homeTeam.name}</div>
              </div>

              <div className="text-center">
                <div className="text-2xl sm:text-3xl font-display font-extrabold text-th-faint">VS</div>
              </div>

              <div className="text-center">
                <TeamBadge teamId={state.awayTeam.id} shortName={state.awayTeam.shortName} primaryColor={state.awayTeam.primaryColor} size="lg" />
                <div className="mt-2 font-display font-bold text-th-primary text-sm sm:text-base">{state.awayTeam.shortName}</div>
                <div className="text-[10px] text-th-muted font-display">{state.awayTeam.name}</div>
              </div>
            </div>

            {/* Venue card */}
            <div className="rounded-xl bg-th-body/60 border border-th p-4 mb-6">
              <div className="text-center">
                <div className="text-xs text-th-muted uppercase tracking-wider font-display font-semibold mb-1">Venue</div>
                <div className="font-display font-bold text-th-primary text-sm sm:text-base">{stadiumName}</div>
                <div className="text-xs text-th-muted font-display mt-0.5">{city}</div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                <div className="text-center">
                  <div className="text-[10px] text-th-faint uppercase tracking-wider font-display">Pitch</div>
                  <div className="text-xs text-th-secondary font-display font-semibold capitalize">{pitchType}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-th-faint uppercase tracking-wider font-display">Boundary</div>
                  <div className="text-xs text-th-secondary font-display font-semibold capitalize">{boundarySize}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-th-faint uppercase tracking-wider font-display">Dew</div>
                  <div className="text-xs text-th-secondary font-display font-semibold capitalize">{dewFactor}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-th-faint uppercase tracking-wider font-display">Conditions</div>
                  <div className="text-xs text-th-secondary font-display font-semibold">{getStadiumLabel(stadiumRating)}</div>
                </div>
              </div>
            </div>

            {/* Key players spotlight */}
            {(homeStarPlayer || awayStarPlayer) && (
              <div className="mb-6">
                <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold text-center mb-3">Key Players</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {homeStarPlayer && (
                    <div
                      className="rounded-xl border border-th p-3 flex items-center gap-3"
                      style={{ background: `${state.homeTeam.primaryColor}08` }}
                    >
                      <PlayerAvatar name={homeStarPlayer.name} imageUrl={homeStarPlayer.imageUrl} size="lg" teamColor={state.homeTeam.primaryColor} />
                      <div className="flex-1 min-w-0">
                        <div className="font-display font-bold text-th-primary text-sm truncate">{homeStarPlayer.name}</div>
                        <div className="text-[10px] text-th-muted font-display">
                          BAT {homeStarPlayer.battingOvr} | BWL {homeStarPlayer.bowlingOvr}
                        </div>
                        <div className="text-[10px] font-display mt-0.5" style={{ color: state.homeTeam.primaryColor }}>
                          {state.homeTeam.shortName}
                        </div>
                      </div>
                      <div className={`text-sm font-display font-bold px-2 py-1 rounded-lg ${ovrBgClass(homeStarPlayer.overall)}`}>
                        {homeStarPlayer.overall}
                      </div>
                    </div>
                  )}
                  {awayStarPlayer && (
                    <div
                      className="rounded-xl border border-th p-3 flex items-center gap-3"
                      style={{ background: `${state.awayTeam.primaryColor}08` }}
                    >
                      <PlayerAvatar name={awayStarPlayer.name} imageUrl={awayStarPlayer.imageUrl} size="lg" teamColor={state.awayTeam.primaryColor} />
                      <div className="flex-1 min-w-0">
                        <div className="font-display font-bold text-th-primary text-sm truncate">{awayStarPlayer.name}</div>
                        <div className="text-[10px] text-th-muted font-display">
                          BAT {awayStarPlayer.battingOvr} | BWL {awayStarPlayer.bowlingOvr}
                        </div>
                        <div className="text-[10px] font-display mt-0.5" style={{ color: state.awayTeam.primaryColor }}>
                          {state.awayTeam.shortName}
                        </div>
                      </div>
                      <div className={`text-sm font-display font-bold px-2 py-1 rounded-lg ${ovrBgClass(awayStarPlayer.overall)}`}>
                        {awayStarPlayer.overall}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Toss result */}
            <div className="rounded-xl bg-th-body/60 border border-th p-3 mb-6 text-center">
              <div className="text-[10px] text-th-muted uppercase tracking-wider font-display font-semibold mb-1">Toss</div>
              <div className="text-sm text-th-secondary font-display">
                <span className="font-bold text-th-primary" style={{ color: tossWinnerTeam.primaryColor }}>{tossWinnerTeam.name}</span>
                {" "}won the toss and chose to{" "}
                <span className="font-bold text-th-primary">{state.tossDecision === "bat" ? "bat" : "bowl"}</span> first
              </div>
            </div>

            {/* Start Match button */}
            <div className="text-center">
              <button
                onClick={() => setShowBuildup(false)}
                className="px-8 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-bold rounded-xl transition-all duration-200 shadow-lg shadow-orange-500/20 text-sm sm:text-base"
              >
                Start Match
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
      {/* Score flash overlay */}
      {flashType && (
        <div className={`fixed inset-0 pointer-events-none z-50 transition-opacity duration-300 ${
          flashType === "four" ? "bg-emerald-500/10" :
          flashType === "six" ? "bg-amber-500/10" :
          "bg-red-500/10"
        }`} />
      )}

      {/* Live Scoreboard */}
      <div className="rounded-2xl overflow-hidden mb-4 border border-th">
        {/* Team header strip */}
        <div className="flex items-stretch">
          <div
            className="flex-1 px-4 py-2 text-center text-xs font-display font-bold tracking-wide"
            style={{
              background: `linear-gradient(135deg, ${battingTeam.primaryColor}30, ${battingTeam.primaryColor}10)`,
              color: battingTeam.primaryColor,
              borderBottom: `2px solid ${battingTeam.primaryColor}`,
            }}
          >
            {battingTeam.shortName} -- BATTING
          </div>
          <div
            className="flex-1 px-4 py-2 text-center text-xs font-display font-medium tracking-wide text-th-muted"
            style={{
              background: `linear-gradient(135deg, ${bowlingTeam.primaryColor}15, transparent)`,
              borderBottom: `1px solid ${bowlingTeam.primaryColor}40`,
            }}
          >
            {bowlingTeam.shortName} -- BOWLING
          </div>
        </div>

        {/* Venue indicator */}
        {(() => {
          const homeTeamFull = teams?.find(t => t.id === state.homeTeam.id);
          if (!homeTeamFull) return null;
          const rating = homeTeamFull.config.stadiumBowlingRating ?? 1.0;
          const label = getStadiumLabel(rating);
          const stadiumName = homeTeamFull.config.stadiumName ?? `${homeTeamFull.config.city} Stadium`;
          return (
            <div className="px-4 py-1.5 bg-th-body/60 text-center border-b border-th/30">
              <span className="text-[11px] text-th-muted font-display">
                {stadiumName}, {homeTeamFull.config.city} &mdash; {label} ({rating.toFixed(2)})
              </span>
            </div>
          );
        })()}

        {/* Main score area */}
        <div className="bg-th-raised px-4 sm:px-6 py-4">
          <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-6">
            <div className="flex-1 text-center sm:text-left">
              <div className="flex items-baseline gap-2 justify-center sm:justify-start">
                <span
                  className="text-xs font-display font-bold uppercase tracking-wider mr-1"
                  style={{ color: battingTeam.primaryColor }}
                >
                  {battingTeam.shortName}
                </span>
                <span className="text-4xl sm:text-5xl font-display font-extrabold text-th-primary stat-num tracking-tight">
                  {state.score}<span className="text-th-muted">/</span>{state.wickets}
                </span>
                <span className="text-base text-th-muted font-display">
                  ({oversDisplay})
                </span>
              </div>

              {state.innings === 2 && state.innings1Score !== undefined && (
                <div className="text-sm text-th-muted mt-1 font-display">
                  {state._internal.battingFirstId === state.homeTeam.id ? state.homeTeam.shortName : state.awayTeam.shortName}: {state.innings1Score}/{state.innings1Wickets} ({state.innings1Overs} ov)
                </div>
              )}

              {state.innings === 2 && state.target && runsNeeded > 0 && (
                <div className="text-sm font-display font-semibold text-amber-400 mt-1">
                  Need {runsNeeded} from {ballsLeft} balls
                </div>
              )}
              {/* Win probability bar */}
              {state.status === "in_progress" && (() => {
                const batTeam = state.battingTeamId === state.homeTeam.id ? state.homeTeam : state.awayTeam;
                const bowlTeam = state.battingTeamId === state.homeTeam.id ? state.awayTeam : state.homeTeam;
                const winProb = calculateWinProbability({
                  score: state.score,
                  wickets: state.wickets,
                  overs: state.overs,
                  balls: state.balls,
                  innings: state.innings as 1 | 2,
                  target: state.target,
                  battingTeamPower: 80,
                  bowlingTeamPower: 80,
                });
                const battingProb = state.innings === 1 ? winProb : winProb;
                const fieldingProb = 100 - battingProb;
                return (
                  <div className="mt-2 flex items-center gap-2 text-[10px]">
                    <span className="font-display font-semibold" style={{ color: batTeam.primaryColor }}>{batTeam.shortName} {battingProb}%</span>
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-white/[0.06] flex">
                      <div className="h-full transition-all duration-500" style={{ width: `${battingProb}%`, background: batTeam.primaryColor }} />
                      <div className="h-full transition-all duration-500" style={{ width: `${fieldingProb}%`, background: bowlTeam.primaryColor }} />
                    </div>
                    <span className="font-display font-semibold" style={{ color: bowlTeam.primaryColor }}>{fieldingProb}% {bowlTeam.shortName}</span>
                  </div>
                );
              })()}

              {state.innings === 2 && state.target && runsNeeded <= 0 && state.status !== "completed" && (
                <div className="text-sm font-display font-semibold text-emerald-400 mt-1">
                  Target reached!
                </div>
              )}
            </div>

            <div className="flex gap-4 sm:gap-6 text-center">
              <div>
                <div className="text-[10px] text-th-muted uppercase tracking-wider font-display">CRR</div>
                <div className="text-th-primary font-display font-bold stat-num">{currentRunRate}</div>
              </div>
              {state.innings === 2 && requiredRunRate && (
                <div>
                  <div className="text-[10px] text-th-muted uppercase tracking-wider font-display">RRR</div>
                  <div className="text-amber-400 font-display font-bold stat-num">{requiredRunRate}</div>
                </div>
              )}
              <div>
                <div className="text-[10px] text-th-muted uppercase tracking-wider font-display">Innings</div>
                <div className="text-th-secondary font-display font-bold stat-num">{state.innings}/2</div>
              </div>
            </div>
          </div>

          {/* Current batters */}
          <div className="mt-3 pt-3 border-t border-th flex flex-wrap gap-x-6 gap-y-1 items-center text-sm">
            {state.batterStats.filter(b => !b.isOut).slice(-2).map(b => {
              const isStriker = b.playerId === state._internal.battingOrderIds[state.strikerIdx];
              return (
                <span key={b.playerId} className={`font-mono flex items-center gap-1.5 ${isStriker ? "text-th-primary font-semibold" : "text-th-secondary"}`}>
                  <PlayerAvatar name={b.playerName} imageUrl={playerImageMap[b.playerId]} size="sm" teamColor={battingTeam.primaryColor} />
                  {b.playerName}{isStriker ? "*" : ""}{" "}
                  <span className="text-th-muted">{b.runs}({b.balls})</span>
                </span>
              );
            })}
            <span className="text-th-faint mx-1">|</span>
            {state.bowlerStats.length > 0 && (() => {
              const b = state.bowlerStats.find(b => b.playerId === state._internal.bowlingOrderIds[state.currentBowlerIdx])
                ?? state.bowlerStats[state.bowlerStats.length - 1];
              const oversStr = b.balls > 0 ? `${b.overs}.${b.balls}` : `${b.overs}`;
              return (
                <span className="font-mono text-th-secondary flex items-center gap-1.5">
                  <PlayerAvatar name={b.playerName} imageUrl={playerImageMap[b.playerId]} size="sm" teamColor={bowlingTeam.primaryColor} />
                  {b.playerName} <span className="text-th-muted">{oversStr}-{b.maidens}-{b.runs}-{b.wickets}</span>
                </span>
              );
            })()}
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-th-body">
          <div
            className="h-full transition-all duration-300 bg-gradient-to-r from-orange-500 to-amber-500"
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          />
        </div>
      </div>

      {/* Main content: ball feed + scorecard panel */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Ball-by-ball feed */}
        <div className="flex-1">
          <div
            ref={ballFeedRef}
            className="bg-th-raised rounded-xl border border-th overflow-y-auto font-mono text-sm"
            style={{ maxHeight: "420px", minHeight: "280px" }}
          >
            {/* This over dot summary */}
            {recentBalls.length > 0 && (() => {
              const currentOver = recentBalls[recentBalls.length - 1]?.over;
              const thisOverBalls = recentBalls.filter(b => b.over === currentOver && b.innings === recentBalls[recentBalls.length - 1].innings);
              return (
                <div className="px-4 py-2 border-b border-th flex items-center gap-2">
                  <span className="text-[10px] text-th-muted font-display uppercase tracking-wider">This Over</span>
                  <div className="flex items-center gap-1.5">
                    {thisOverBalls.map((b, i) => (
                      <span
                        key={i}
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                          b.eventType === "wicket" ? "bg-red-500/30 text-red-400" :
                          b.eventType === "six" ? "bg-purple-500/30 text-purple-300" :
                          b.eventType === "four" ? "bg-emerald-500/30 text-emerald-400" :
                          b.eventType === "dot" ? "bg-white/[0.04] text-th-faint" :
                          b.eventType === "wide" || b.eventType === "noball" ? "bg-amber-500/20 text-amber-400" :
                          "bg-white/[0.06] text-th-muted"
                        }`}
                      >
                        {b.eventType === "wicket" ? "W" : b.eventType === "wide" ? "wd" : b.runs}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}

            {recentBalls.length === 0 && (
              <div className="text-th-muted text-center py-12 font-display">
                {state.status === "in_progress" ? "Press Play to start the match" : "No balls bowled yet"}
              </div>
            )}

            {recentBalls.map((ball, i) => {
              const prevBall = i > 0 ? recentBalls[i - 1] : null;
              const isNewOver = prevBall && (ball.over !== prevBall.over || ball.innings !== prevBall.innings);
              const isInningsChange = prevBall && ball.innings !== prevBall.innings;

              return (
                <div key={i}>
                  {isInningsChange && (
                    <div className="px-4 py-2 bg-th-body border-y border-th text-center">
                      <span className="text-xs text-th-muted font-display font-semibold">--- INNINGS BREAK ---</span>
                    </div>
                  )}
                  {isNewOver && !isInningsChange && (
                    <div className="px-4 py-1.5 bg-th-body/50 border-y border-th/50">
                      <span className="text-[10px] text-th-faint font-display uppercase tracking-wider">
                        End of over {prevBall.over + 1}
                        {" "}-- {prevBall.scoreSoFar}/{prevBall.wicketsSoFar}
                      </span>
                    </div>
                  )}
                  <div
                    className={`px-4 py-1.5 flex items-start gap-2 border-b border-th/30 transition-colors ${
                      i === recentBalls.length - 1 ? "animate-slide-in" : ""
                    } ${
                      ball.eventType === "wicket" ? "bg-red-950/20" :
                      ball.eventType === "four" ? "bg-emerald-950/15" :
                      ball.eventType === "six" ? "bg-amber-950/15" :
                      ""
                    }`}
                  >
                    <span className="text-th-faint w-8 text-right shrink-0 text-xs pt-0.5">
                      {ball.over}.{ball.ball}
                    </span>
                    <span className={`w-8 text-center shrink-0 text-xs font-bold rounded px-1 py-0.5 ${
                      ball.eventType === "wicket" ? "bg-red-500/20 text-red-400" :
                      ball.eventType === "four" ? "bg-emerald-500/20 text-emerald-400" :
                      ball.eventType === "six" ? "bg-amber-500/20 text-amber-400" :
                      ball.eventType === "dot" ? "text-th-faint" :
                      ball.eventType === "wide" || ball.eventType === "noball" ? "text-purple-400" :
                      "text-th-muted"
                    }`}>
                      {ball.eventType === "wicket" ? "W" :
                       ball.eventType === "four" ? "4" :
                       ball.eventType === "six" ? "6" :
                       ball.eventType === "dot" ? "0" :
                       ball.eventType === "wide" ? "Wd" :
                       ball.eventType === "noball" ? "Nb" :
                       ball.eventType === "legbye" ? "Lb" :
                       ball.runs.toString()}
                    </span>
                    <span className="text-th-secondary text-xs leading-relaxed flex-1">
                      {ball.commentary}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Scorecard side panel (desktop) / collapsible section (mobile) */}
        <div className="w-full lg:w-80 shrink-0 space-y-3">
          {/* Scorecard toggle on mobile */}
          <button
            className="lg:hidden w-full py-2 px-4 bg-th-raised rounded-xl border border-th text-xs font-display font-semibold text-th-muted hover:text-th-primary transition-colors flex items-center justify-between"
            onClick={() => setScorecardOpen(!scorecardOpen)}
            aria-label="Toggle scorecard"
            aria-expanded={scorecardOpen}
          >
            <span>Full Scorecard</span>
            <svg className={`w-4 h-4 transition-transform ${scorecardOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <div className={`${scorecardOpen ? "block" : "hidden"} lg:block space-y-3`}>
            {/* Scorecard tabs */}
            <div className="flex rounded-lg overflow-hidden border border-th">
              {(["batting", "bowling", "fow"] as ScorecardTab[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => setScorecardTab(tab)}
                  className={`flex-1 px-2 py-1.5 text-[10px] uppercase tracking-wider font-display font-semibold transition-colors ${
                    scorecardTab === tab
                      ? "bg-orange-500/20 text-orange-400"
                      : "bg-th-raised text-th-muted hover:text-th-primary hover:bg-th-hover"
                  }`}
                >
                  {tab === "fow" ? "F.O.W" : tab}
                </button>
              ))}
            </div>

            {/* Batting Scorecard */}
            {scorecardTab === "batting" && (
              <div className="bg-th-raised rounded-xl border border-th overflow-hidden">
                <div className="px-3 py-2 border-b border-th">
                  <h3 className="text-[10px] uppercase tracking-wider text-th-muted font-display font-semibold">
                    Batting -- {battingTeam.shortName}
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-th-faint text-[10px] uppercase tracking-wider border-b border-th">
                        <th className="text-left px-3 py-1.5 font-display">Batter</th>
                        <th className="text-left px-2 py-1.5 font-display hidden sm:table-cell">Status</th>
                        <th className="text-right px-2 py-1.5 font-display">R</th>
                        <th className="text-right px-2 py-1.5 font-display">B</th>
                        <th className="text-right px-2 py-1.5 font-display">4s</th>
                        <th className="text-right px-2 py-1.5 font-display">6s</th>
                        <th className="text-right px-2 py-1.5 font-display">SR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.batterStats.map((b, idx) => {
                        const isStriker = b.playerId === state._internal.battingOrderIds[state.strikerIdx] && !b.isOut;
                        const isNonStriker = b.playerId === state._internal.battingOrderIds[state.nonStrikerIdx] && !b.isOut;
                        const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : "0.0";
                        return (
                          <tr
                            key={b.playerId}
                            className={`border-b border-th/30 ${
                              idx % 2 === 0 ? "bg-th-raised" : "bg-th-body/30"
                            } ${b.isOut ? "opacity-60" : ""}`}
                            style={isStriker ? { borderLeft: `3px solid ${battingTeam.primaryColor}` } : undefined}
                          >
                            <td className="px-3 py-1.5">
                              <span className={`${isStriker ? "text-th-primary font-semibold" : isNonStriker ? "text-th-secondary font-medium" : b.isOut ? "text-th-faint" : "text-th-secondary"}`}>
                                {b.playerName}{isStriker ? "*" : ""}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-th-faint hidden sm:table-cell">
                              {b.isOut ? b.howOut : "not out"}
                            </td>
                            <td className="text-right px-2 py-1.5 font-mono font-semibold text-th-primary">{b.runs}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-muted">{b.balls}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-emerald-500">{b.fours || "-"}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-amber-500">{b.sixes || "-"}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-muted">{sr}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Extras + Total */}
                <div className="px-3 py-1.5 border-t border-th flex justify-between text-xs">
                  <span className="text-th-faint">Extras</span>
                  <span className="font-mono text-th-muted">{state.extras}</span>
                </div>
                <div className="px-3 py-1.5 border-t border-th flex justify-between text-xs font-semibold">
                  <span className="text-th-secondary">Total</span>
                  <span className="font-mono text-th-primary">{state.score}/{state.wickets} ({oversDisplay} ov)</span>
                </div>

                {/* Yet to bat */}
                {yetToBat.length > 0 && (
                  <div className="px-3 py-2 border-t border-th">
                    <div className="text-[10px] text-th-faint uppercase tracking-wider font-display mb-1">Yet to bat</div>
                    <div className="text-xs text-th-muted">
                      {yetToBat.map((p, i) => (
                        <span key={p.id}>
                          {p.name}{i < yetToBat.length - 1 ? ", " : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Bowling Scorecard */}
            {scorecardTab === "bowling" && (
              <div className="bg-th-raised rounded-xl border border-th overflow-hidden">
                <div className="px-3 py-2 border-b border-th">
                  <h3 className="text-[10px] uppercase tracking-wider text-th-muted font-display font-semibold">
                    Bowling -- {bowlingTeam.shortName}
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-th-faint text-[10px] uppercase tracking-wider border-b border-th">
                        <th className="text-left px-3 py-1.5 font-display">Bowler</th>
                        <th className="text-right px-2 py-1.5 font-display">O</th>
                        <th className="text-right px-2 py-1.5 font-display">M</th>
                        <th className="text-right px-2 py-1.5 font-display">R</th>
                        <th className="text-right px-2 py-1.5 font-display">W</th>
                        <th className="text-right px-2 py-1.5 font-display">Econ</th>
                        <th className="text-right px-2 py-1.5 font-display">Dots</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.bowlerStats.filter(b => b.overs > 0 || b.balls > 0).map((b, idx) => {
                        const oversStr = b.balls > 0 ? `${b.overs}.${b.balls}` : `${b.overs}.0`;
                        const effectiveOvers = b.overs + b.balls / 6;
                        const econ = effectiveOvers > 0 ? (b.runs / effectiveOvers).toFixed(2) : "0.00";
                        const isCurrent = b.playerId === state._internal.bowlingOrderIds[state.currentBowlerIdx];
                        return (
                          <tr
                            key={b.playerId}
                            className={`border-b border-th/30 ${
                              idx % 2 === 0 ? "bg-th-raised" : "bg-th-body/30"
                            }`}
                            style={isCurrent ? { borderLeft: `3px solid ${bowlingTeam.primaryColor}` } : undefined}
                          >
                            <td className="px-3 py-1.5">
                              <span className={`${isCurrent ? "text-th-primary font-semibold" : "text-th-secondary"}`}>
                                {b.playerName}{isCurrent ? "*" : ""}
                              </span>
                            </td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-muted">{oversStr}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-muted">{b.maidens}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-primary">{b.runs}</td>
                            <td className="text-right px-2 py-1.5 font-mono font-semibold text-red-400">{b.wickets}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-muted">{econ}</td>
                            <td className="text-right px-2 py-1.5 font-mono text-th-faint">{b.dots}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Fall of Wickets */}
            {scorecardTab === "fow" && (
              <div className="bg-th-raised rounded-xl border border-th p-3">
                <h3 className="text-[10px] uppercase tracking-wider text-th-muted font-display font-semibold mb-2">
                  Fall of Wickets
                </h3>
                {state.fallOfWickets.length === 0 ? (
                  <div className="text-xs text-th-faint">No wickets have fallen yet</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {state.fallOfWickets.map((fow, i) => (
                      <span
                        key={i}
                        className="inline-block px-2 py-1 text-[10px] font-mono bg-red-500/10 text-red-400 rounded-full border border-red-500/20"
                      >
                        {fow}
                      </span>
                    ))}
                  </div>
                )}

                {/* Innings 1 FOW if in second innings */}
                {state.innings === 2 && state.innings1Scorecard && state.innings1Scorecard.fallOfWickets.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-th">
                    <h4 className="text-[10px] uppercase tracking-wider text-th-faint font-display mb-1.5">
                      1st Innings FOW
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {state.innings1Scorecard.fallOfWickets.map((fow, i) => (
                        <span
                          key={i}
                          className="inline-block px-2 py-1 text-[10px] font-mono bg-th-body text-th-faint rounded-full border border-th"
                        >
                          {fow}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Innings 1 scorecard preview (when in 2nd innings) */}
            {state.innings === 2 && state.innings1Scorecard && (
              <div className="bg-th-raised rounded-xl border border-th p-3">
                <h3 className="text-[10px] uppercase tracking-wider text-th-faint font-display font-semibold mb-2">
                  1st Innings -- {state.innings1Scorecard.battingTeamName.split(" ").pop()}
                </h3>
                <div className="text-sm font-display font-bold text-th-secondary stat-num mb-1">
                  {state.innings1Score}/{state.innings1Wickets} ({state.innings1Overs} ov)
                </div>
                <div className="space-y-0.5">
                  {state.innings1Scorecard.batters.slice(0, 3).map(b => (
                    <div key={b.playerId} className="flex justify-between text-[11px]">
                      <span className="text-th-faint truncate pr-2">{b.playerName}</span>
                      <span className="font-mono text-th-muted">{b.runs}({b.balls})</span>
                    </div>
                  ))}
                  {state.innings1Scorecard.batters.length > 3 && (
                    <div className="text-[10px] text-th-faint">+ {state.innings1Scorecard.batters.length - 3} more</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ────── Decision Modals ────── */}

      {/* Choose Bowler Modal */}
      {isDecisionForUser && state.pendingDecision!.type === "choose_bowler" && (
        <DecisionModal title="Choose Your Bowler" subtitle={`${battingTeam.shortName} ${state.score}/${state.wickets} (${oversDisplay} ov)`}>
          <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
            {(state.pendingDecision!.optionDetails ?? []).map((opt, i) => {
              const isRecommended = i === 0 || opt.bowlingOvr === Math.max(...(state.pendingDecision!.optionDetails ?? []).map(o => o.bowlingOvr));
              return (
                <button
                  key={opt.playerId}
                  onClick={() => handleDecision("choose_bowler", opt.playerId)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all hover:border-orange-500/50 hover:bg-orange-500/5 ${
                    isRecommended && i === 0 ? "border-orange-500/30 bg-orange-500/5" : "border-th bg-th-body"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-display font-semibold text-th-primary text-sm">{opt.playerName}</span>
                        <span className="text-[10px] uppercase tracking-wider text-th-faint px-1.5 py-0.5 bg-th-hover rounded">{opt.role}</span>
                        {isRecommended && i === 0 && (
                          <span className="text-[10px] uppercase tracking-wider text-orange-400 px-1.5 py-0.5 bg-orange-500/10 rounded">Recommended</span>
                        )}
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-th-muted font-mono">
                        <span>OVR: {opt.bowlingOvr}</span>
                        {opt.oversBowled !== undefined && <span>{opt.oversBowled}-{opt.oversRemaining} ov left</span>}
                        {opt.runsConceded !== undefined && opt.wicketsTaken !== undefined && <span>{opt.runsConceded}/{opt.wicketsTaken}</span>}
                        {opt.economy !== undefined && opt.economy > 0 && <span>Econ: {opt.economy}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-display font-bold text-th-primary stat-num">{opt.bowlingOvr}</div>
                      <div className="text-[10px] text-th-faint">BOWL</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </DecisionModal>
      )}

      {/* Choose Batter Modal */}
      {isDecisionForUser && state.pendingDecision!.type === "choose_batter" && (() => {
        const opts = state.pendingDecision!.optionDetails ?? [];
        const xiOpts = opts.filter(o => !o.isBench);
        const benchOpts = opts.filter(o => o.isBench);
        return (
          <DecisionModal title="Who Bats Next?" subtitle={`${battingTeam.shortName} ${state.score}/${state.wickets} (${oversDisplay} ov)`}>
            <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
              {xiOpts.map((opt, i) => {
                const isRecommended = i === 0;
                return (
                  <button
                    key={opt.playerId}
                    onClick={() => handleDecision("choose_batter", opt.playerId)}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all hover:border-orange-500/50 hover:bg-orange-500/5 ${
                      isRecommended ? "border-orange-500/30 bg-orange-500/5" : "border-th bg-th-body"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-display font-semibold text-th-primary text-sm">{opt.playerName}</span>
                          <span className="text-[10px] uppercase tracking-wider text-th-faint px-1.5 py-0.5 bg-th-hover rounded">{opt.role}</span>
                          {isRecommended && (
                            <span className="text-[10px] uppercase tracking-wider text-orange-400 px-1.5 py-0.5 bg-orange-500/10 rounded">Recommended</span>
                          )}
                        </div>
                        <div className="flex gap-3 mt-1 text-xs text-th-muted font-mono">
                          <span>BAT: {opt.battingOvr}</span>
                          <span>OVR: {opt.overall}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-display font-bold text-th-primary stat-num">{opt.battingOvr}</div>
                        <div className="text-[10px] text-th-faint">BAT</div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {benchOpts.length > 0 && (
                <>
                  <div className="border-t border-th pt-2 mt-2">
                    <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-display font-semibold">Impact Sub (from bench)</span>
                  </div>
                  {benchOpts.map(opt => (
                    <button
                      key={opt.playerId}
                      onClick={() => handleDecision("choose_batter", opt.playerId)}
                      className="w-full text-left px-4 py-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 transition-all hover:border-emerald-500/50 hover:bg-emerald-500/10"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-display font-semibold text-th-primary text-sm">{opt.playerName}</span>
                            <span className="text-[10px] uppercase tracking-wider text-th-faint px-1.5 py-0.5 bg-th-hover rounded">{opt.role}</span>
                            <span className="text-[10px] uppercase tracking-wider text-emerald-400 px-1.5 py-0.5 bg-emerald-500/10 rounded">BENCH</span>
                          </div>
                          <div className="flex gap-3 mt-1 text-xs text-th-muted font-mono">
                            <span>BAT: {opt.battingOvr}</span>
                            <span>OVR: {opt.overall}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-lg font-display font-bold text-emerald-400 stat-num">{opt.battingOvr}</div>
                          <div className="text-[10px] text-emerald-400/60">SUB</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </DecisionModal>
        );
      })()}

      {/* Toss Decision Modal */}
      {isDecisionForUser && state.pendingDecision!.type === "toss_decision" && (() => {
        const homeTeamFull = teams?.find(t => t.id === state.homeTeam.id);
        const pitchType = state._internal.pitchType ?? "balanced";
        const dewFactor = state._internal.dewFactor ?? "none";
        const stadiumName = homeTeamFull?.config.stadiumName ?? `${homeTeamFull?.config.city ?? "Unknown"} Stadium`;
        return (
          <DecisionModal title="You Won the Toss!" subtitle="Choose to bat or bowl first">
            <div className="space-y-4">
              <div className="rounded-xl bg-th-body border border-th p-3 text-center">
                <div className="text-xs text-th-muted font-display">
                  <span className="text-th-secondary font-semibold">{stadiumName}</span>
                  {" "}&mdash;{" "}
                  <span className="capitalize">{pitchType}</span> pitch, {dewFactor} dew
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => handleDecision("toss_decision", "bat")}
                  className="flex-1 px-5 py-4 rounded-xl border border-orange-500/30 bg-orange-500/5 hover:bg-orange-500/15 hover:border-orange-500/50 transition-all text-center"
                >
                  <div className="text-2xl mb-1">🏏</div>
                  <div className="font-display font-bold text-th-primary text-sm">Bat First</div>
                  <div className="text-[10px] text-th-muted mt-1">Set a target</div>
                </button>
                <button
                  onClick={() => handleDecision("toss_decision", "bowl")}
                  className="flex-1 px-5 py-4 rounded-xl border border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/15 hover:border-blue-500/50 transition-all text-center"
                >
                  <div className="text-2xl mb-1">⚾</div>
                  <div className="font-display font-bold text-th-primary text-sm">Bowl First</div>
                  <div className="text-[10px] text-th-muted mt-1">Chase it down</div>
                </button>
              </div>
            </div>
          </DecisionModal>
        );
      })()}

      {/* DRS Review Modal */}
      {isDecisionForUser && state.pendingDecision!.type === "drs_review" && (() => {
        const drsCtx = state.pendingDecision!.drsContext;
        const bowlingTeamIsHome = state.bowlingTeamId === state.homeTeam.id;
        const reviewsLeft = bowlingTeamIsHome ? state.drsRemaining.home : state.drsRemaining.away;
        const currentBowler = state.currentBowlerName;
        return (
          <DecisionModal title="LBW Appeal!" subtitle="The umpire says NOT OUT. Do you want to review?">
            <div className="space-y-4">
              <div className="rounded-xl bg-th-body border border-th p-4 text-center space-y-2">
                <div className="text-sm text-th-secondary font-display">
                  <span className="text-th-primary font-semibold">{currentBowler}</span> to{" "}
                  <span className="text-th-primary font-semibold">{drsCtx?.batterName ?? "batter"}</span>
                </div>
                <div className="text-xs text-th-muted font-display">
                  {reviewsLeft} review{reviewsLeft !== 1 ? "s" : ""} remaining
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => handleDecision("drs_review", "review")}
                  className="flex-1 px-5 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-display font-semibold text-sm transition-all shadow-lg shadow-blue-500/20"
                >
                  Review (DRS)
                </button>
                <button
                  onClick={() => handleDecision("drs_review", "accept")}
                  className="flex-1 px-5 py-3 rounded-xl bg-th-raised hover:bg-th-hover text-th-secondary font-display font-semibold text-sm border border-th transition-colors"
                >
                  Accept Decision
                </button>
              </div>
            </div>
          </DecisionModal>
        );
      })()}

      {/* DRS Result Flash */}
      {drsResult && (
        <div className="fixed inset-0 pointer-events-none z-50 flex items-center justify-center animate-fade-in">
          <div className={`px-8 py-5 rounded-2xl border text-center ${
            drsResult.success
              ? "bg-red-950/90 border-red-500/40 backdrop-blur-sm"
              : "bg-gray-900/90 border-gray-600/40 backdrop-blur-sm"
          }`}>
            <div className={`text-lg font-display font-extrabold ${
              drsResult.success ? "text-red-400" : "text-th-muted"
            }`}>
              {drsResult.message}
            </div>
          </div>
        </div>
      )}

      {/* Impact Sub Modal */}
      {showImpactSubModal && state && userTeamId && (() => {
        const impactOpts = getImpactSubOptions(state, userTeamId);
        if (!impactOpts) return null;
        return (
          <DecisionModal title="Select Impact Player" subtitle="Choose a bench player to substitute into the playing XI">
            <div className="space-y-4">
              {/* Bench player selection */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-th-muted font-display mb-2">Bring In</div>
                <div className="space-y-1.5 max-h-[30vh] overflow-y-auto">
                  {impactOpts.benchPlayers.map(opt => (
                    <button
                      key={opt.playerId}
                      onClick={() => setImpactSubIn(opt.playerId)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
                        impactSubIn === opt.playerId
                          ? "border-orange-500 bg-orange-500/10"
                          : "border-th bg-th-body hover:border-th hover:bg-th-hover"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-display font-semibold text-th-primary text-sm">{opt.playerName}</span>
                          <span className="text-[10px] uppercase tracking-wider text-th-faint ml-2">{opt.role}</span>
                        </div>
                        <div className="flex gap-2 text-xs font-mono text-th-muted">
                          <span>BAT:{opt.battingOvr}</span>
                          <span>BOWL:{opt.bowlingOvr}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* XI player to swap out */}
              {impactSubIn && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-th-muted font-display mb-2">Replace</div>
                  <div className="space-y-1.5 max-h-[30vh] overflow-y-auto">
                    {impactOpts.xiPlayers.map(opt => (
                      <button
                        key={opt.playerId}
                        onClick={() => setImpactSubOut(opt.playerId)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
                          impactSubOut === opt.playerId
                            ? "border-red-500 bg-red-500/10"
                            : "border-th bg-th-body hover:border-th hover:bg-th-hover"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-display font-semibold text-th-secondary text-sm">{opt.playerName}</span>
                            <span className="text-[10px] uppercase tracking-wider text-th-faint ml-2">{opt.role}</span>
                          </div>
                          <div className="flex gap-2 text-xs font-mono text-th-muted">
                            <span>BAT:{opt.battingOvr}</span>
                            <span>BOWL:{opt.bowlingOvr}</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleSkipImpactSub}
                  className="flex-1 px-4 py-2.5 bg-th-hover text-th-muted font-display font-semibold rounded-xl border border-th text-sm transition-colors hover:bg-th-body"
                >
                  Skip
                </button>
                <button
                  onClick={handleApplyImpactSub}
                  disabled={!impactSubIn || !impactSubOut}
                  className="flex-1 px-4 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Confirm Sub
                </button>
              </div>
            </div>
          </DecisionModal>
        );
      })()}

      {/* Innings break overlay */}
      {showInningsBreak && state.status === "innings_break" && !showImpactSubModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center animate-fade-in">
          <div className="bg-th-raised rounded-2xl border border-th p-6 sm:p-8 max-w-md w-full mx-4 text-center">
            <div className="text-xs text-th-muted uppercase tracking-widest font-display mb-3">Innings Break</div>
            <div className="text-2xl font-display font-extrabold text-th-primary mb-1">
              {state._internal.battingFirstId === state.homeTeam.id ? state.homeTeam.shortName : state.awayTeam.shortName}{" "}
              <span className="stat-num">{state.innings1Score}/{state.innings1Wickets}</span>
            </div>
            <div className="text-th-muted text-sm mb-2">({state.innings1Overs} overs)</div>

            <div className="text-sm text-th-secondary mt-3 mb-6">
              <span className="font-semibold" style={{ color: bowlingTeam.primaryColor }}>
                {state._internal.bowlingFirstId === state.homeTeam.id ? state.homeTeam.name : state.awayTeam.name}
              </span>{" "}
              need <span className="font-bold text-amber-400">{state.target}</span> runs to win
            </div>

            <button
              onClick={handleStartSecondInnings}
              className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all text-sm"
            >
              Start 2nd Innings
            </button>
          </div>
        </div>
      )}

      {/* Match complete overlay */}
      {matchComplete && state.status === "completed" && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center animate-fade-in">
          <div className="bg-th-raised rounded-2xl border border-th p-6 sm:p-8 max-w-md w-full mx-4 text-center">
            <div className="text-xs text-th-muted uppercase tracking-widest font-display mb-3">Match Complete</div>

            <div className="text-xl sm:text-2xl font-display font-extrabold text-th-primary mb-3">
              {state.result}
            </div>

            {state.manOfTheMatch && (
              <div className="mb-4">
                <div className="text-[10px] text-th-muted uppercase tracking-wider font-display">Man of the Match</div>
                <div className="text-th-primary font-display font-bold">{state.manOfTheMatch.playerName}</div>
                <div className="text-th-muted text-xs font-mono">{state.manOfTheMatch.reason}</div>
              </div>
            )}

            <div className="flex justify-center gap-6 mb-6">
              <div className="text-center">
                <div className="text-xs text-th-muted font-display">
                  {state._internal.battingFirstId === state.homeTeam.id ? state.homeTeam.shortName : state.awayTeam.shortName}
                </div>
                <div className="font-display font-bold text-th-primary stat-num">
                  {state.innings1Score}/{state.innings1Wickets}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-th-muted font-display">
                  {state._internal.bowlingFirstId === state.homeTeam.id ? state.homeTeam.shortName : state.awayTeam.shortName}
                </div>
                <div className="font-display font-bold text-th-primary stat-num">
                  {state.score}/{state.wickets}
                </div>
              </div>
            </div>

            {/* Narrative events */}
            {narrativeEvents.length > 0 && (
              <div className="mb-5 space-y-2 text-left max-h-[30vh] overflow-y-auto">
                {narrativeEvents.map((evt, i) => (
                  <div
                    key={i}
                    className={`px-3 py-2.5 rounded-lg border text-xs ${
                      evt.type === "praise" ? "border-emerald-800/40 bg-emerald-950/20" :
                      evt.type === "criticism" || evt.type === "board" ? "border-red-800/40 bg-red-950/20" :
                      evt.type === "milestone" ? "border-amber-800/40 bg-amber-950/20" :
                      "border-th bg-th-body"
                    }`}
                  >
                    <div className={`font-display font-semibold text-sm mb-0.5 ${
                      evt.type === "praise" ? "text-emerald-400" :
                      evt.type === "criticism" || evt.type === "board" ? "text-red-400" :
                      evt.type === "milestone" ? "text-amber-400" :
                      "text-blue-400"
                    }`}>
                      {evt.headline}
                    </div>
                    <div className="text-th-muted leading-relaxed">{evt.body}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => navigate(`/match/${matchIndex}`)}
                className="px-5 py-2.5 bg-th-hover text-th-primary font-display font-semibold rounded-xl border border-th text-sm transition-colors hover:bg-th-body"
              >
                View Full Scorecard
              </button>
              <button
                onClick={() => navigate("/season")}
                className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl transition-all text-sm"
              >
                Back to Season
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Controls bar */}
      <div className="sticky bottom-0 left-0 right-0 mt-4 -mx-3 sm:-mx-6 px-3 sm:px-6 py-3 glass border-t border-th z-30">
        <div className="flex items-center gap-3 max-w-6xl mx-auto">
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            disabled={state.status !== "in_progress"}
            className={`w-11 h-11 rounded-full flex items-center justify-center transition-all shrink-0 ${
              state.status !== "in_progress"
                ? "bg-th-hover text-th-faint cursor-not-allowed"
                : playing
                ? "bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 ring-2 ring-orange-500/30"
                : "bg-gradient-to-r from-orange-500 to-amber-500 text-white hover:from-orange-400 hover:to-amber-400 shadow-lg shadow-orange-500/20"
            }`}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>

          {/* Speed buttons */}
          <div className="flex rounded-lg overflow-hidden border border-th">
            {(["1x", "2x", "5x", "instant"] as Speed[]).map(s => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                aria-label={`Playback speed ${s === "instant" ? "instant simulation" : s}`}
                className={`px-2.5 sm:px-3 py-1.5 text-xs font-display font-semibold transition-colors ${
                  speed === s
                    ? "bg-orange-500/20 text-orange-400"
                    : "bg-th-raised text-th-muted hover:text-th-primary hover:bg-th-hover"
                }`}
              >
                {s === "instant" ? "Sim" : s}
              </button>
            ))}
          </div>

          {/* Aggression slider — only for user's batting team */}
          {isUserMatch && state.battingTeamId === userTeamId && (
            <div className="flex items-center gap-2 ml-2">
              <span className="text-[10px] text-th-muted font-display whitespace-nowrap">
                {state.aggression[state.battingTeamId === state.homeTeam.id ? 'home' : 'away'] <= 25 ? '🛡️' :
                 state.aggression[state.battingTeamId === state.homeTeam.id ? 'home' : 'away'] >= 75 ? '⚔️' : '⚖️'}
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="10"
                value={state.aggression[state.battingTeamId === state.homeTeam.id ? 'home' : 'away']}
                onChange={e => {
                  const level = parseInt(e.target.value);
                  setState(prev => prev ? setAggression(prev, userTeamId!, level) : prev);
                }}
                className="w-16 sm:w-24 accent-orange-500 h-1.5"
                title={`Aggression: ${state.aggression[state.battingTeamId === state.homeTeam.id ? 'home' : 'away']}%`}
              />
              <span className="text-[10px] text-th-muted font-mono w-6">
                {state.aggression[state.battingTeamId === state.homeTeam.id ? 'home' : 'away']}
              </span>
            </div>
          )}

          {/* Field setting selector — only for user's bowling team */}
          {isUserMatch && state.bowlingTeamId === userTeamId && (() => {
            const side = state.bowlingTeamId === state.homeTeam.id ? "home" : "away";
            const currentField = state.fieldSetting[side as "home" | "away"];
            const FIELD_OPTIONS: { value: FieldSetting; label: string; color: string }[] = [
              { value: "aggressive", label: "AGG", color: "text-red-400 bg-red-500/10 border-red-500/30" },
              { value: "standard", label: "STD", color: "text-th-secondary bg-th-body border-th" },
              { value: "defensive", label: "DEF", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
              { value: "spin-attack", label: "SPN", color: "text-purple-400 bg-purple-500/10 border-purple-500/30" },
              { value: "boundary-save", label: "BDY", color: "text-amber-400 bg-amber-500/10 border-amber-500/30" },
            ];
            return (
              <div className="flex items-center gap-1.5 ml-2">
                <span className="text-[10px] text-th-muted font-display hidden sm:inline">Field:</span>
                <div className="flex rounded-lg overflow-hidden border border-th">
                  {FIELD_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setState(prev => prev ? setFieldSetting(prev, userTeamId!, opt.value) : prev)}
                      title={opt.value.replace(/-/g, " ")}
                      className={`px-1.5 sm:px-2 py-1 text-[10px] font-display font-semibold transition-colors ${
                        currentField === opt.value
                          ? opt.color
                          : "bg-th-raised text-th-faint hover:text-th-muted"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="flex-1" />

          {/* Decision pending indicator */}
          {state.status === "waiting_for_decision" && isUserMatch && (
            <span className="px-3 py-1 text-xs font-display font-semibold text-amber-400 bg-amber-500/10 rounded-lg border border-amber-500/20 animate-pulse">
              Decision Required
            </span>
          )}

          {/* Step one ball */}
          <button
            onClick={() => { setPlaying(false); doStepBall(); }}
            disabled={state.status !== "in_progress"}
            className="hidden sm:block px-3 py-1.5 text-xs font-display font-semibold bg-th-raised text-th-muted hover:text-th-primary border border-th rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Step
          </button>

          {/* Sim rest */}
          <button
            onClick={handleSimRest}
            disabled={state.status === "completed"}
            className="px-3 sm:px-4 py-1.5 text-xs font-display font-semibold bg-th-raised text-th-muted hover:text-th-primary border border-th rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Sim Rest
          </button>

          <span className="hidden sm:inline text-xs text-th-faint font-mono">
            {state.innings === 2 ? `Inn 2: ${oversDisplay}` : `Inn 1: ${oversDisplay}`} / 20
          </span>
        </div>
      </div>
    </div>
  );
}

/* ────── Reusable Decision Modal wrapper ────── */

function DecisionModal({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in p-4">
      <div className="bg-gray-900 rounded-2xl border border-gray-700/50 w-full max-w-lg mx-auto max-h-[90vh] flex flex-col overflow-hidden lg:max-h-[80vh]">
        <div className="px-5 pt-5 pb-3 border-b border-gray-800">
          <h2 className="text-lg font-display font-bold text-white">{title}</h2>
          {subtitle && <p className="text-xs text-gray-400 font-mono mt-1">{subtitle}</p>}
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {children}
        </div>
      </div>
    </div>
  );
}
