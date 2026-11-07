/**
 * Multiplayer draft room UI (season draft or Draft Match) for the host and every guest.
 * Renders purely from DraftRoomView; actions go to the host (directly for the host, via PeerJS
 * for guests).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chooseAiPick, getCurrentSeatId, getSquad } from "@ipl-sim/engine";
import type { DraftRoomView } from "../multiplayer/draft-room";
import type { DraftRoomSettings, DraftRoomMember, DraftSeries } from "../multiplayer/protocol";
import { DRAFT_MATCH_POOLS, draftMatchCountries, draftMatchVenues, type DraftMatchLineup } from "../draft-pools";
import { MULTIPLAYER_LEAGUES } from "../multiplayer/leagues";
import { DraftBoard, type SeatStyle } from "./DraftBoard";
import { LineupEditor, DraftMatchViewer, MatchResultCard } from "./DraftMatchParts";

export interface DraftRoomActions {
  claimSeat: (seatId: string | null) => void;
  pick: (playerId: string) => void;
  setQueue: (ids: string[]) => void;
  submitLineup: (lineup: DraftMatchLineup) => void;
  rematch: () => void;
  leave: () => void;
  host?: {
    updateSettings: (patch: Partial<DraftRoomSettings>) => void;
    start: () => void;
    pause: () => void;
    resume: () => void;
    undo: () => void;
    simRemaining: () => void;
    kick: (peerId: string) => void;
    setSeatAI: (seatId: string) => void;
  };
}

export function DraftRoom({ view, myPeerId, actions }: { view: DraftRoomView; myPeerId: string; actions: DraftRoomActions }) {
  const room = view.room;
  const [queue, setQueueLocal] = useState<string[]>([]);
  const [autoDraft, setAutoDraft] = useState(false);
  const [watching, setWatching] = useState(true);
  const [copied, setCopied] = useState(false);
  const isHost = !!actions.host;
  const me = room?.members.find(m => m.peerId === myPeerId);
  const mySeatId = me?.seatId ?? null;
  const countries = useMemo(() => (room?.phase === "lobby" && room.settings.pool === "nations" ? draftMatchCountries() : []), [room?.phase, room?.settings.pool]);
  const venues = useMemo(() => draftMatchVenues(), []);

  const setQueue = (ids: string[]) => { setQueueLocal(ids); actions.setQueue(ids); };

  // A new game's match-start → watch it live again
  useEffect(() => { if (view.matchStart) setWatching(true); }, [view.matchStart]);

  // Auto-draft: pick locally with the same AI the host uses (queue first)
  const draft = view.draft;
  const myTurn = !!draft && draft.status === "in-progress" && !!mySeatId && getCurrentSeatId(draft) === mySeatId;
  const lastAuto = useRef(-1);
  useEffect(() => {
    if (!autoDraft || !myTurn || !draft || lastAuto.current === draft.picks.length) return;
    lastAuto.current = draft.picks.length;
    const { playerId } = chooseAiPick(draft, mySeatId!, queue);
    if (playerId) actions.pick(playerId);
  }, [autoDraft, myTurn, draft, mySeatId, queue, actions]);

  if (view.kicked) {
    return <Centered title="You were removed from the room" sub={view.kicked} onBack={actions.leave} />;
  }
  if (!room) return <Centered title="Connecting…" onBack={actions.leave} />;

  const seatStyles: Record<string, SeatStyle> = Object.fromEntries(room.seats.map(s => [s.seatId, { short: s.shortName, color: s.color }]));
  const seatOwners: Record<string, string> = Object.fromEntries(room.seats.map(s => [s.seatId, s.ownerName ?? "CPU"]));
  const seatNames: Record<string, string> = Object.fromEntries(room.seats.map(s => [s.seatId, s.name]));
  const isMatch = room.settings.mode === "draft-match";
  const humans = room.members.filter(m => m.seatId);
  const spectators = room.members.filter(m => !m.seatId);

  const header = (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
      <div>
        <h2 className="text-2xl font-display font-bold text-th-primary tracking-tight">
          {isMatch ? "Draft Match" : "Season Draft"} <span className="text-th-muted text-base font-medium">· multiplayer</span>
        </h2>
        <p className="text-th-muted text-xs font-display mt-1">
          {humans.length} drafting · {spectators.length} watching{room.poolLabel ? ` · ${room.poolLabel}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted">Code</span>
        <span className="text-2xl font-mono font-bold text-th-primary tracking-[0.12em]" data-testid="room-code">{room.roomCode}</span>
        <button onClick={() => { navigator.clipboard?.writeText(room.roomCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="text-xs text-th-muted hover:text-th-primary px-2">{copied ? "Copied" : "Copy"}</button>
        <button onClick={actions.leave} className="text-xs text-red-400/80 hover:text-red-400 px-2">Leave</button>
      </div>
    </div>
  );

  // ── Lobby ──
  if (room.phase === "lobby") {
    const s = room.settings;
    const set = actions.host?.updateSettings;
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 animate-fade-in">
        {header}
        <div className="rounded-2xl border border-th bg-th-surface p-4 mb-5">
          <h3 className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-3">Room settings {isHost ? "" : "(host decides)"}</h3>
          <div className="flex flex-wrap gap-3 text-xs font-display text-th-muted">
            <Select label="Mode" value={s.mode} disabled={!set} onChange={v => set?.({ mode: v as DraftRoomSettings["mode"] })}
              options={[["draft-match", "Draft Match (build an XI, play)"], ["season-draft", "Season draft (full squads, then a season)"]]} />
            {isMatch ? (
              <>
                <Select label="Sides" value={String(s.sides)} disabled={!set} onChange={v => set?.({ sides: Number(v) })}
                  options={[["2", "2 (head-to-head, best of 3)"], ["3", "3 (round-robin)"], ["4", "4 (round-robin)"]]} />
                <Select label="Pool" value={s.pool} disabled={!set} onChange={v => set?.({ pool: v as DraftRoomSettings["pool"] })}
                  options={DRAFT_MATCH_POOLS.map(p => [p.id, p.label])} />
                {s.pool === "nations" && countries.length > 0 && [0, 1].map(i => (
                  <Select key={i} label={i ? "vs" : "Nations"} value={(s.nations ?? ["India", "Australia"])[i]} disabled={!set}
                    onChange={v => { const n = [...(s.nations ?? ["India", "Australia"])] as [string, string]; n[i] = v; set?.({ nations: n }); }}
                    options={countries.map(c => [c.country, c.country])} />
                ))}
                <Select label="Venue" value={s.venueTeamId ?? ""} disabled={!set} onChange={v => set?.({ venueTeamId: v || null })}
                  options={[["", "Random ground"], ...venues.map(v => [v.teamId, v.stadiumName] as [string, string])]} />
              </>
            ) : (
              <>
                <Select label="League" value={s.league} disabled={!set} onChange={v => set?.({ league: v as DraftRoomSettings["league"] })}
                  options={MULTIPLAYER_LEAGUES.map(l => [l.id, `${l.short} (${l.teams} teams)`] as [string, string])} />
                <Select label="Draft order" value={s.order} disabled={!set} onChange={v => set?.({ order: v as "random" | "listed" })} options={[["random", "Random"], ["listed", "As listed below"]]} />
              </>
            )}
            <Select label="Order" value={s.draftType} disabled={!set} onChange={v => set?.({ draftType: v as "snake" | "linear" })}
              options={[["snake", isMatch ? "Snake (A B B A)" : "Snake"], ["linear", isMatch ? "Alternating (A B A B)" : "Linear"]]} />
            <Select label="Pick clock" value={String(s.pickSeconds)} disabled={!set} onChange={v => set?.({ pickSeconds: Number(v) })}
              options={[["0", "Off"], ["15", "15s"], ["30", "30s"], ["45", "45s"], ["60", "60s"]]} />
          </div>
        </div>

        <h3 className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2">
          {isMatch ? "Sides" : "Teams"} — empty seats are drafted by the CPU
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-5" data-testid="draft-seats">
          {room.seats.map(seat => {
            const mine = seat.seatId === mySeatId;
            const takenByOther = !!seat.ownerPeerId && !mine;
            const owner = room.members.find(m => m.peerId === seat.ownerPeerId);
            return (
              <div key={seat.seatId} className={`rounded-2xl border p-3 ${mine ? "border-orange-500/50 bg-orange-500/[0.07]" : "border-th bg-th-surface"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: seat.color }} />
                  <span className="text-sm font-display font-semibold text-th-primary truncate">{seat.shortName}</span>
                </div>
                <div className={`text-[11px] font-display truncate ${mine ? "text-orange-400" : takenByOther ? "text-emerald-400/80" : "text-th-faint"}`}>
                  {mine ? "You" : owner ? `${owner.name}${owner.connected ? "" : " (offline)"}` : "CPU"}
                </div>
                <div className="flex gap-1 mt-2">
                  {!takenByOther && !mine && (
                    <button onClick={() => actions.claimSeat(seat.seatId)} className="text-[11px] px-2 py-1 rounded-lg bg-th-raised hover:bg-th-hover text-th-secondary font-display">Take seat</button>
                  )}
                  {mine && <button onClick={() => actions.claimSeat(null)} className="text-[11px] px-2 py-1 rounded-lg bg-th-raised hover:bg-th-hover text-th-secondary font-display">Leave seat</button>}
                  {isHost && takenByOther && (
                    <button onClick={() => actions.host!.setSeatAI(seat.seatId)} className="text-[11px] px-2 py-1 rounded-lg bg-th-raised hover:bg-th-hover text-th-muted font-display">Make CPU</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <MemberList members={room.members} myPeerId={myPeerId} onKick={actions.host?.kick} />

        {isHost ? (
          <button onClick={actions.host!.start} data-testid="draft-room-start"
            className="mt-5 px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl shadow-lg shadow-orange-500/20">
            Start the draft
          </button>
        ) : (
          <p className="mt-5 text-th-muted text-sm font-display">Waiting for the host to start… {mySeatId ? "" : "Take a seat to draft, or stay to watch."}</p>
        )}
      </div>
    );
  }

  // ── Drafting ──
  if (room.phase === "drafting" && draft) {
    const h = actions.host;
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 animate-fade-in">
        {header}
        {room.series && <SeriesLine series={room.series} names={seatNames} />}
        <DraftBoard
          draft={draft}
          mySeatIds={mySeatId ? [mySeatId] : []}
          seatStyles={seatStyles}
          seatOwners={seatOwners}
          secondsLeft={view.secondsLeft}
          onPick={mySeatId ? actions.pick : undefined}
          queue={queue}
          onQueueChange={setQueue}
          autoDraft={autoDraft}
          onAutoDraftChange={setAutoDraft}
          announcements={view.feed}
          maxOverseasInXI={draft.config.maxOverseasInXI}
          pickError={view.error}
          headerActions={h && (
            <>
              {draft.status === "paused"
                ? <HostBtn onClick={h.resume}>Resume</HostBtn>
                : <HostBtn onClick={h.pause}>Pause</HostBtn>}
              <HostBtn onClick={h.undo}>Undo last pick</HostBtn>
              <HostBtn onClick={h.simRemaining}>Auto-draft the rest</HostBtn>
            </>
          )}
        />
        <div className="mt-4"><MemberList members={room.members} myPeerId={myPeerId} onKick={actions.host?.kick} onMakeAI={actions.host?.setSeatAI} /></div>
      </div>
    );
  }

  // ── Lineups (Draft Match) ──
  if (room.phase === "lineups" && draft) {
    const submitted = mySeatId ? room.lineupsIn?.includes(mySeatId) : true;
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 animate-fade-in">
        {header}
        {mySeatId && !submitted ? (
          <LineupEditor players={getSquad(draft, mySeatId)} maxOverseasInXI={draft.config.maxOverseasInXI} onConfirm={actions.submitLineup} />
        ) : (
          <div className="rounded-2xl border border-th bg-th-surface p-5 text-sm font-display text-th-secondary">
            Waiting for lineups: {room.seats.filter(s => !room.lineupsIn?.includes(s.seatId)).map(s => s.name).join(", ") || "starting…"}
          </div>
        )}
      </div>
    );
  }

  // ── Match + results ──
  if (isMatch && view.matchStart && watching && room.seats.length === 2) {
    return <DraftMatchViewer start={view.matchStart} userSeatId={null} onDone={() => setWatching(false)} onSkip={() => setWatching(false)} />;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 animate-fade-in space-y-4">
      {header}
      {view.matchResult && view.matchStart && (
        <>
          <MatchResultCard
            summary={view.matchResult.summary}
            shareText={view.matchResult.shareText}
            series={view.matchResult.series}
            seatNames={seatNames}
            sides={view.matchStart.sides.map(s => ({
              id: s.seatId, name: s.name,
              xi: s.battingOrder.map(id => s.players.find(p => p.id === id)?.name ?? id),
              captain: s.players.find(p => p.id === s.captainId)?.name,
            }))}
          />
          {(mySeatId || isHost) && (
            <button onClick={actions.rematch} data-testid="draft-room-rematch"
              className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-semibold rounded-xl">
              {view.matchResult.series?.winnerSeatId ? "New best-of-3" : `Game ${(view.matchResult.series?.game ?? 1) + 1}: ${seatNames[view.matchResult.series?.nextFirstSeatId ?? ""] ?? "loser"} picks first`}
            </button>
          )}
        </>
      )}

      {view.roundRobin && (
        <div className="rounded-2xl border border-th bg-th-surface p-5">
          <h3 className="text-lg font-display font-bold text-gradient-orange mb-3">Round-robin table</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-[10px] uppercase text-th-muted font-display"><th className="text-left">Side</th><th>P</th><th>W</th><th>L</th><th>T</th><th>Pts</th></tr></thead>
            <tbody>
              {view.roundRobin.table.map(r => (
                <tr key={r.seatId} className="border-t border-th text-center font-mono text-th-secondary">
                  <td className="text-left font-display text-th-primary py-1">{r.name}</td><td>{r.played}</td><td>{r.won}</td><td>{r.lost}</td><td>{r.tied}</td><td className="font-bold">{r.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 space-y-1">
            {view.roundRobin.results.map(r => (
              <div key={r.gameNo} className="text-xs text-th-secondary font-display">
                {r.summary.innings1.battingTeamName} {r.summary.innings1.totalRuns}/{r.summary.innings1.totalWickets} v {r.summary.innings2.battingTeamName} {r.summary.innings2.totalRuns}/{r.summary.innings2.totalWickets} — {r.summary.result}
              </div>
            ))}
          </div>
          {(mySeatId || isHost) && <button onClick={actions.rematch} className="mt-4 px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-display font-semibold rounded-xl">Draft again</button>}
        </div>
      )}

      {view.seasonResults && (
        <div className="rounded-2xl border border-th bg-th-surface p-5">
          <h3 className="text-lg font-display font-bold text-gradient-orange mb-1">Champions: {view.seasonResults.champion}</h3>
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-[10px] uppercase text-th-muted font-display"><th className="text-left">Team</th><th>W</th><th>L</th><th>Pts</th></tr></thead>
            <tbody>
              {view.seasonResults.standings.map(s => (
                <tr key={s.teamId} className="border-t border-th text-center font-mono text-th-secondary">
                  <td className="text-left font-display text-th-primary py-1">{s.shortName}{seatOwners[s.teamId] && seatOwners[s.teamId] !== "CPU" ? ` (${seatOwners[s.teamId]})` : ""}</td>
                  <td>{s.wins}</td><td>{s.losses}</td><td className="font-bold">{s.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.seasonSquads && (
        <div className="grid sm:grid-cols-2 gap-3">
          {view.seasonSquads.map(sq => (
            <div key={sq.seatId} className="rounded-xl border border-th bg-th-surface p-3 text-[11px] text-th-muted">
              <div className="text-sm font-display font-semibold text-th-primary mb-1">{sq.name}</div>
              {sq.players.join(", ")}
            </div>
          ))}
        </div>
      )}
      {!view.matchResult && !view.roundRobin && !view.seasonResults && (
        <p className="text-th-muted text-sm font-display">Simulating…</p>
      )}
    </div>
  );
}

function Select({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: [string, string][]; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      {label}
      <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}
        className="bg-th-raised border border-th rounded-lg px-2 py-1 text-th-secondary disabled:opacity-70 max-w-[230px]">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function HostBtn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="px-3 py-2 rounded-xl border border-th bg-th-raised text-xs font-display font-semibold text-th-secondary hover:bg-th-hover">
      {children}
    </button>
  );
}

function MemberList({ members, myPeerId, onKick, onMakeAI }: {
  members: DraftRoomMember[];
  myPeerId: string;
  onKick?: (peerId: string) => void;
  onMakeAI?: (seatId: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-th bg-th-surface p-4">
      <h3 className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2">In the room</h3>
      <div className="flex flex-wrap gap-2">
        {members.map(m => (
          <div key={m.peerId} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-display ${m.peerId === myPeerId ? "border-orange-500/30 bg-orange-500/[0.06]" : "border-th bg-th-raised"}`}>
            <span className={`w-2 h-2 rounded-full ${m.connected ? (m.isHost ? "bg-amber-400" : "bg-emerald-400") : "bg-gray-500"}`} />
            <span className="text-th-primary">{m.name}</span>
            <span className="text-th-faint">{m.seatId ? "drafting" : "watching"}{m.connected ? "" : " · offline"}</span>
            {onMakeAI && m.seatId && !m.isHost && <button onClick={() => onMakeAI(m.seatId!)} className="text-th-muted hover:text-th-primary">→CPU</button>}
            {onKick && !m.isHost && <button onClick={() => onKick(m.peerId)} className="text-red-400/70 hover:text-red-400">Kick</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SeriesLine({ series, names }: { series: DraftSeries; names: Record<string, string> }) {
  return (
    <p className="mb-3 text-xs font-display text-th-muted">
      Best of {series.bestOf} · {Object.entries(series.wins).map(([id, w]) => `${names[id] ?? id} ${w}`).join(" – ")}
    </p>
  );
}

function Centered({ title, sub, onBack }: { title: string; sub?: string; onBack: () => void }) {
  return (
    <div className="max-w-md mx-auto px-4 py-16 text-center">
      <h2 className="text-xl font-display font-bold text-th-primary">{title}</h2>
      {sub && <p className="text-th-muted text-sm font-display mt-2">{sub}</p>}
      <button onClick={onBack} className="mt-6 text-orange-400 hover:text-orange-300 text-sm font-display">Back</button>
    </div>
  );
}
