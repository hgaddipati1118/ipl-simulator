/**
 * Season draft (single player): you draft for your franchise, CPU teams draft the rest.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getCurrentSeatId, isDraftComplete, getSquad, squadStrength } from "@ipl-sim/engine";
import type { GameState } from "../game-state";
import { DraftBoard, type SeatStyle } from "../components/DraftBoard";

interface Props {
  state: GameState;
  onPick: (playerId: string) => string | undefined; // returns an error message if the pick failed
  onAutoPick: (queue: string[]) => void;
  onCpuPick: () => void;
  onUndo: () => void;
  onSimRemaining: () => void;
  onFinish: () => void;
}

type Speed = "slow" | "normal" | "fast";
const CPU_DELAY: Record<Speed, number> = { slow: 1200, normal: 450, fast: 60 };

export function DraftPage({ state, onPick, onAutoPick, onCpuPick, onUndo, onSimRemaining, onFinish }: Props) {
  const navigate = useNavigate();
  const draft = state.draftState;
  const [queue, setQueue] = useState<string[]>([]);
  const [autoDraft, setAutoDraft] = useState(false);
  const [speed, setSpeed] = useState<Speed>("normal");
  const [pickError, setPickError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const autoPickRef = useRef(onAutoPick);
  autoPickRef.current = onAutoPick;
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const userTeamId = state.userTeamId;
  const currentSeatId = draft ? getCurrentSeatId(draft) : null;
  const myTurn = !!draft && draft.status === "in-progress" && currentSeatId === userTeamId;
  const complete = !!draft && isDraftComplete(draft);
  const pickSeconds = draft?.config.pickSeconds ?? 0;

  const seatStyles = useMemo(() => {
    const out: Record<string, SeatStyle> = {};
    for (const t of state.teams) out[t.id] = { short: t.shortName, color: t.config.primaryColor };
    return out;
  }, [state.teams]);

  // CPU picks, one at a time with a short delay so the board is watchable
  useEffect(() => {
    if (!draft || draft.status !== "in-progress" || complete || myTurn) return;
    const t = setTimeout(onCpuPick, CPU_DELAY[speed]);
    return () => clearTimeout(t);
  }, [draft, complete, myTurn, speed, onCpuPick]);

  // Pick clock for the user (resets every time it's your turn)
  const pickKey = draft?.picks.length ?? 0;
  useEffect(() => {
    if (!myTurn) { setSecondsLeft(null); return; }
    if (autoDraft) {
      const t = setTimeout(() => autoPickRef.current(queueRef.current), 300);
      return () => clearTimeout(t);
    }
    if (pickSeconds <= 0) { setSecondsLeft(null); return; }
    setSecondsLeft(pickSeconds);
    const iv = setInterval(() => setSecondsLeft(s => (s === null ? s : Math.max(0, s - 1))), 1000);
    return () => clearInterval(iv);
  }, [myTurn, pickKey, autoDraft, pickSeconds]);

  // Clock expired → auto-pick (queue first)
  const firedForPick = useRef(-1);
  useEffect(() => {
    if (myTurn && secondsLeft === 0 && firedForPick.current !== pickKey) {
      firedForPick.current = pickKey;
      autoPickRef.current(queueRef.current);
    }
  }, [myTurn, secondsLeft, pickKey]);

  if (!draft) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <p className="text-th-muted font-display">No draft in progress.</p>
        <button onClick={() => navigate("/")} className="mt-4 text-orange-400 hover:text-orange-300 text-sm font-display">Back to setup</button>
      </div>
    );
  }

  const handlePick = (playerId: string) => {
    const err = onPick(playerId);
    setPickError(err ?? null);
    if (!err) setQueue(q => q.filter(id => id !== playerId));
  };

  const strengths = complete
    ? draft.seats.map(s => ({ seat: s, strength: squadStrength(getSquad(draft, s.id)) })).sort((a, b) => b.strength - a.strength)
    : [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-5">
        <div>
          <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">Season Draft</h2>
          <p className="text-th-muted text-sm font-display mt-1">
            {draft.config.type === "snake" ? "Snake order" : "Linear order"} · {draft.seats.length} teams · {draft.config.rounds} rounds
            {Object.values(draft.keepers).some(k => k.length) ? " · retained players fill early rounds" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-display">
          <span className="text-th-muted">CPU speed</span>
          {(["slow", "normal", "fast"] as Speed[]).map(s => (
            <button key={s} onClick={() => setSpeed(s)}
              className={`px-2.5 py-1 rounded-lg border ${speed === s ? "border-orange-500/40 text-orange-400" : "border-th text-th-muted hover:text-th-primary"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {complete ? (
        <div className="rounded-2xl border border-th bg-th-surface p-6 mb-5">
          <h3 className="text-lg font-display font-bold text-gradient-orange mb-3">Draft complete</h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
            {strengths.map(({ seat, strength }, i) => (
              <div key={seat.id} className={`rounded-xl border p-3 ${seat.id === userTeamId ? "border-orange-500/30 bg-orange-500/[0.06]" : "border-th bg-th-raised"}`}>
                <div className="text-[10px] text-th-faint font-mono">#{i + 1}</div>
                <div className="text-sm font-display font-semibold text-th-primary truncate">{seatStyles[seat.id]?.short ?? seat.name}</div>
                <div className="text-[11px] font-mono text-th-muted">Top-XI avg {strength}</div>
              </div>
            ))}
          </div>
          <button onClick={onFinish} data-testid="draft-finish"
            className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl shadow-lg shadow-orange-500/20">
            Start the season
          </button>
        </div>
      ) : null}

      <DraftBoard
        draft={draft}
        mySeatIds={userTeamId ? [userTeamId] : []}
        seatStyles={seatStyles}
        secondsLeft={secondsLeft}
        onPick={handlePick}
        queue={queue}
        onQueueChange={setQueue}
        autoDraft={autoDraft}
        onAutoDraftChange={setAutoDraft}
        maxOverseasInXI={state.rules.maxOverseasInXI}
        pickError={pickError}
        headerActions={!complete && (
          <>
            <button onClick={onUndo} className="px-3 py-2 rounded-xl border border-th bg-th-raised text-xs font-display font-semibold text-th-secondary hover:bg-th-hover">
              Undo my pick
            </button>
            <button onClick={onSimRemaining} data-testid="draft-sim-remaining"
              className="px-3 py-2 rounded-xl border border-th bg-th-raised text-xs font-display font-semibold text-th-secondary hover:bg-th-hover">
              Auto-draft the rest
            </button>
          </>
        )}
      />
    </div>
  );
}
