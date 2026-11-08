/**
 * Draft Match: a quick head-to-head mode that needs no league.
 * You and an opponent alternate picks from one pool to build an XI each (ABBA snake by default),
 * set a batting order and captain, then play the match straight away. Best of 3: loser picks first. T20 or ODI: an ODI
 * draft plays 50-over matches and the pool shows (and plays on) the players' ODI ratings.
 * Playing a friend goes through the multiplayer lobby (same draft engine and protocol).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  type DraftState, type DraftType, type Player,
  createDraft, applyDraftAction, runAiPicks, getCurrentSeatId, getSquad, isDraftComplete, toDraftPlayer,
} from "@ipl-sim/engine";
import {
  DRAFT_MATCH_POOLS, buildDraftMatchPool, draftMatchCountries, draftMatchVenues, draftPoolVenues, draftPoolLeague, ensurePoolCoverage,
  autoLineup, buildDraftMatchTeam, summarizeMatch, shareableResult, toOdiPool, draftPoolIsWomen,
  type DraftMatchPoolId, type DraftMatchLineup, type DraftMatchResultSummary, type DraftMatchFormat,
} from "../draft-pools";
import { loadFormatRatings } from "../format-ratings";
import { DraftBoard } from "../components/DraftBoard";
import { LineupEditor, DraftMatchViewer, MatchResultCard } from "../components/DraftMatchParts";
import type { DraftMatchStart } from "../multiplayer/protocol";

type Phase = "setup" | "toss" | "draft" | "lineup" | "match" | "result";
const YOU = "you";
const CPU = "cpu";
const CPU_DELAY_MS = 650;

interface Series { wins: Record<string, number>; game: number; nextFirst: string | null; winner: string | null }
const NEW_SERIES: Series = { wins: { [YOU]: 0, [CPU]: 0 }, game: 0, nextFirst: null, winner: null };

export function DraftMatchPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("setup");
  const [poolId, setPoolId] = useState<DraftMatchPoolId>("ipl-current");
  const [format, setFormat] = useState<DraftMatchFormat>("t20");
  const [loadingPool, setLoadingPool] = useState(false);
  const [nations, setNations] = useState<[string, string]>(["India", "Australia"]);
  const [draftType, setDraftType] = useState<DraftType>("snake");
  const [pickSeconds, setPickSeconds] = useState(30);
  const [venueTeamId, setVenueTeamId] = useState<string | null>(null);
  const [players, setPlayers] = useState<Map<string, Player>>(new Map());
  const [maxOs, setMaxOs] = useState<number | undefined>(4);
  const [poolLabel, setPoolLabel] = useState("");
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [autoDraft, setAutoDraft] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [series, setSeries] = useState<Series>(NEW_SERIES);
  const [start, setStart] = useState<DraftMatchStart | null>(null);
  const [result, setResult] = useState<{ summary: DraftMatchResultSummary; shareText: string; sides: { id: string; name: string; xi: string[]; captain?: string }[] } | null>(null);

  const countries = useMemo(() => (phase === "setup" ? draftMatchCountries() : []), [phase]);
  const venues = useMemo(() => draftMatchVenues(), []);

  // ── Start a draft (new series or next game) ──
  const beginGame = async (nextSeries: Series) => {
    const built = buildDraftMatchPool(poolId, nations);
    let pool = ensurePoolCoverage(built.players, 2, built.maxOverseasInXI);
    if (format === "odi") {
      // the pool on ODI ratings (the file is fetched once; without it everyone keeps his T20 ratings)
      setLoadingPool(true);
      pool = toOdiPool(pool, await loadFormatRatings());
      setLoadingPool(false);
    }
    setPlayers(new Map(pool.map(p => [p.id, p])));
    setMaxOs(built.maxOverseasInXI);
    setPoolLabel(format === "odi" ? `${built.label} · ODI ratings` : built.label);
    const seed = Math.floor(Math.random() * 2 ** 31);
    const first = nextSeries.nextFirst ?? (Math.random() < 0.5 ? YOU : CPU); // coin toss for game 1
    const seats = [
      { id: YOU, name: "Your XI", controller: "human" as const },
      { id: CPU, name: "CPU XI", controller: "ai" as const },
    ];
    let d = createDraft({
      config: {
        type: draftType, rounds: 11, maxOverseas: built.maxOverseasInXI, maxOverseasInXI: built.maxOverseasInXI,
        minWicketKeepers: 1, minBowlingOptions: 5, pickSeconds, seed,
      },
      seats: first === YOU ? seats : [seats[1], seats[0]],
      pool: pool.map(toDraftPlayer),
    });
    d = applyDraftAction(d, { type: "start" }).state;
    setDraft(d);
    setQueue([]);
    setSeries(nextSeries);
    setResult(null);
    setStart(null);
    setPhase("toss");
  };

  // ── CPU picks ──
  const currentSeat = draft ? getCurrentSeatId(draft) : null;
  const myTurn = phase === "draft" && !!draft && draft.status === "in-progress" && currentSeat === YOU;
  useEffect(() => {
    if (phase !== "draft" || !draft || draft.status !== "in-progress" || currentSeat !== CPU) return;
    const t = setTimeout(() => setDraft(d => (d ? runAiPicks(d, 1).state : d)), CPU_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase, draft, currentSeat]);

  // ── Your pick clock / auto-draft ──
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const autoPickYou = () => setDraft(d => {
    if (!d || getCurrentSeatId(d) !== YOU) return d;
    const res = applyDraftAction(d, { type: "auto-pick", seatId: YOU, queue: queueRef.current });
    return res.error ? d : res.state;
  });
  const pickKey = draft?.picks.length ?? 0;
  useEffect(() => {
    if (!myTurn) { setSecondsLeft(null); return; }
    if (autoDraft) { const t = setTimeout(autoPickYou, 300); return () => clearTimeout(t); }
    if (pickSeconds <= 0) { setSecondsLeft(null); return; }
    setSecondsLeft(pickSeconds);
    const iv = setInterval(() => setSecondsLeft(s => (s === null ? s : Math.max(0, s - 1))), 1000);
    return () => clearInterval(iv);
  }, [myTurn, pickKey, autoDraft, pickSeconds]);
  const fired = useRef(-1);
  useEffect(() => {
    if (myTurn && secondsLeft === 0 && fired.current !== pickKey) { fired.current = pickKey; autoPickYou(); }
  }, [myTurn, secondsLeft, pickKey]);

  // Draft finished → lineups
  useEffect(() => {
    if (phase === "draft" && draft && isDraftComplete(draft)) setPhase("lineup");
  }, [phase, draft]);

  const handlePick = (playerId: string) => {
    if (!draft) return;
    const res = applyDraftAction(draft, { type: "pick", seatId: YOU, playerId });
    setPickError(res.error ?? null);
    if (!res.error) { setDraft(res.state); setQueue(q => q.filter(id => id !== playerId)); }
  };

  // ── Lineups → match ──
  const startMatch = (yourLineup: DraftMatchLineup) => {
    if (!draft) return;
    const venue = venueTeamId ?? draftPoolVenues(poolId)
      .sort(() => Math.random() - 0.5)[0]?.teamId ?? "mi";
    const order = draft.seats.map(s => s.id); // first picker is "home"
    const sides = order.map((seatId, i) => {
      const squad = getSquad(draft, seatId);
      const lineup = seatId === YOU ? yourLineup : autoLineup(squad);
      const team = buildDraftMatchTeam(
        { id: seatId, name: seatId === YOU ? "Your XI" : "CPU XI", shortName: seatId === YOU ? "YOU" : "CPU" },
        i, squad.map(p => players.get(p.id)!).filter(Boolean), lineup, venue,
      );
      return { seatId, name: team.name, shortName: team.shortName, players: team.roster.map(p => p.toJSON()), battingOrder: team.userBattingOrder ?? [], captainId: lineup.captainId };
    });
    setStart({
      gameNo: series.game + 1,
      seed: Math.floor(Math.random() * 2 ** 31),
      venueTeamId: venue,
      maxOverseasInXI: maxOs,
      ...(format === "odi" ? { format, women: draftPoolIsWomen(poolId) } : {}),
      sides: sides as unknown as DraftMatchStart["sides"],
    });
    setPhase("match");
  };

  const finishMatch = (state: import("@ipl-sim/engine").MatchState) => {
    if (!start) return;
    const summary = summarizeMatch(state);
    const wins = { ...series.wins };
    if (summary.winnerSideId) wins[summary.winnerSideId] = (wins[summary.winnerSideId] ?? 0) + 1;
    const loser = summary.winnerSideId === YOU ? CPU : summary.winnerSideId === CPU ? YOU : (start.sides[1].seatId);
    const winner = wins[YOU] >= 2 ? YOU : wins[CPU] >= 2 ? CPU : null;
    const next: Series = { wins, game: series.game + 1, nextFirst: loser, winner };
    const sides = start.sides.map(s => ({
      id: s.seatId, name: s.name,
      xi: s.battingOrder.map(id => s.players.find(p => p.id === id)?.name ?? id),
      captain: s.players.find(p => p.id === s.captainId)?.name,
    }));
    setSeries(next);
    setResult({ summary, sides, shareText: shareableResult({ sides, summary, series: `Game ${next.game} of best-of-3 · You ${wins[YOU]}–${wins[CPU]} CPU` }) });
    setPhase("result");
  };

  // ── Render ──

  if (phase === "setup") {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-display font-extrabold tracking-tight mb-2">
            <span className="text-gradient-orange">Draft</span><span className="text-th-primary ml-3">Match</span>
          </h1>
          <p className="text-th-muted font-display">Take turns picking players, build an XI each, and play it out. Best of 3.</p>
        </div>

        <div className="space-y-5">
          <Section title="Player pool">
            <div className="grid sm:grid-cols-2 gap-2">
              {DRAFT_MATCH_POOLS.map(p => (
                <button key={p.id} onClick={() => setPoolId(p.id)}
                  className={`text-left p-3 rounded-xl border transition-colors ${poolId === p.id ? "border-orange-500/40 bg-orange-500/[0.07]" : "border-th bg-th-surface hover:bg-th-hover"}`}>
                  <div className="text-sm font-display font-semibold text-th-primary">{p.label}</div>
                  <div className="text-[11px] text-th-muted">{p.desc}</div>
                </button>
              ))}
            </div>
            {poolId === "nations" && (
              <div className="flex flex-wrap items-center gap-2 mt-3 text-xs font-display text-th-muted">
                {[0, 1].map(i => (
                  <select key={i} value={nations[i]} onChange={e => setNations(n => (i === 0 ? [e.target.value, n[1]] : [n[0], e.target.value]))}
                    className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-th-secondary">
                    {countries.map(c => <option key={c.country} value={c.country}>{c.country} ({c.players})</option>)}
                  </select>
                ))}
              </div>
            )}
          </Section>

          <Section title="Format">
            <div className="grid grid-cols-2 gap-2">
              {([["t20", "T20", "20 overs a side, on T20 ratings"], ["odi", "ODI", "50 overs a side, on ODI ratings"]] as const).map(([id, label, desc]) => (
                <button key={id} onClick={() => setFormat(id)} data-testid={`draft-match-format-${id}`}
                  className={`text-left p-3 rounded-xl border transition-colors ${format === id ? "border-orange-500/40 bg-orange-500/[0.07]" : "border-th bg-th-surface hover:bg-th-hover"}`}>
                  <div className="text-sm font-display font-semibold text-th-primary">{label}</div>
                  <div className="text-[11px] text-th-muted">{desc}</div>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Draft">
            <div className="flex flex-wrap gap-4 text-xs font-display text-th-muted">
              <label className="flex items-center gap-2">Pick order
                <select value={draftType} onChange={e => setDraftType(e.target.value as DraftType)} className="bg-th-raised border border-th rounded-lg px-2 py-1 text-th-secondary">
                  <option value="snake">Snake (A B B A)</option>
                  <option value="linear">Alternating (A B A B)</option>
                </select>
              </label>
              <label className="flex items-center gap-2">Pick clock
                <select value={pickSeconds} onChange={e => setPickSeconds(Number(e.target.value))} className="bg-th-raised border border-th rounded-lg px-2 py-1 text-th-secondary">
                  {[0, 15, 30, 60].map(n => <option key={n} value={n}>{n ? `${n}s` : "Off"}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2">Venue
                <select value={venueTeamId ?? ""} onChange={e => setVenueTeamId(e.target.value || null)} className="bg-th-raised border border-th rounded-lg px-2 py-1 text-th-secondary max-w-[220px]">
                  <option value="">Random ground</option>
                  {venues.map(v => <option key={v.teamId} value={v.teamId}>{v.stadiumName}</option>)}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-th-faint font-display mt-2">Each XI needs a wicket-keeper and 5 bowling options{poolId === "ipl-current" ? ", with at most 4 overseas players" : poolId === "wpl-current" ? ", with at most 5 overseas players" : draftPoolLeague(poolId) ? `, with at most ${draftPoolLeague(poolId)!.rules.maxOverseasInXI} overseas players` : ""}.</p>
          </Section>

          <div className="grid sm:grid-cols-2 gap-3">
            <button onClick={() => void beginGame(NEW_SERIES)} data-testid="draft-match-start" disabled={loadingPool}
              className="px-5 py-4 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-60 text-white font-display font-semibold rounded-xl shadow-lg shadow-orange-500/20">
              {loadingPool ? "Loading ODI ratings..." : `Play vs CPU${format === "odi" ? " (ODI)" : ""}`}
            </button>
            <button onClick={() => navigate("/multiplayer", { state: { mode: "draft-match" } })}
              className="px-5 py-4 bg-th-surface border border-th hover:bg-th-hover text-th-primary font-display font-semibold rounded-xl">
              Play friends (multiplayer)
            </button>
          </div>
          <div className="text-center">
            <button onClick={() => navigate("/")} className="text-th-muted hover:text-th-primary text-sm font-display">Back to setup</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "toss" && draft) {
    const youFirst = draft.seats[0].id === YOU;
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center animate-fade-in">
        <div className="text-5xl mb-4">🪙</div>
        <h2 className="text-2xl font-display font-bold text-th-primary mb-2">
          {series.game === 0 ? (youFirst ? "You won the toss" : "CPU won the toss") : `Game ${series.game + 1}`}
        </h2>
        <p className="text-th-muted font-display mb-1">{youFirst ? "You pick first." : "CPU picks first."}</p>
        {series.game > 0 && <p className="text-th-faint text-xs font-display mb-1">The loser of the last game picks first.</p>}
        <p className="text-th-faint text-xs font-display mb-6">{poolLabel} · {draft.config.type === "snake" ? "snake order" : "alternating"}</p>
        <button onClick={() => setPhase("draft")} data-testid="draft-match-begin"
          className="px-8 py-3 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-semibold rounded-xl">
          Start drafting
        </button>
      </div>
    );
  }

  if (phase === "draft" && draft) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 animate-fade-in">
        <SeriesBar series={series} />
        <DraftBoard
          draft={draft}
          mySeatIds={[YOU]}
          seatStyles={{ [YOU]: { short: "YOU", color: "#f97316" }, [CPU]: { short: "CPU", color: "#2563eb" } }}
          secondsLeft={secondsLeft}
          onPick={handlePick}
          queue={queue}
          onQueueChange={setQueue}
          autoDraft={autoDraft}
          onAutoDraftChange={setAutoDraft}
          maxOverseasInXI={maxOs}
          pickError={pickError}
        />
      </div>
    );
  }

  if (phase === "lineup" && draft) {
    const mine = getSquad(draft, YOU);
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 animate-fade-in">
        <SeriesBar series={series} />
        <LineupEditor players={mine} maxOverseasInXI={maxOs} onConfirm={startMatch} confirmLabel="Play the match" />
      </div>
    );
  }

  if (phase === "match" && start) {
    return <DraftMatchViewer start={start} userSeatId={YOU} onDone={finishMatch} />;
  }

  if (phase === "result" && result) {
    const names = { [YOU]: "You", [CPU]: "CPU" };
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in space-y-4">
        <MatchResultCard summary={result.summary} sides={result.sides} shareText={result.shareText}
          series={{ bestOf: 3, game: series.game, wins: series.wins, winnerSeatId: series.winner ?? undefined }} seatNames={names} />
        <div className="flex flex-wrap gap-3">
          {!series.winner ? (
            <button onClick={() => void beginGame(series)} data-testid="draft-match-rematch"
              className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-semibold rounded-xl">
              Game {series.game + 1}: {series.nextFirst === YOU ? "you pick first" : "CPU picks first"}
            </button>
          ) : (
            <button onClick={() => void beginGame(NEW_SERIES)} className="px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-semibold rounded-xl">
              New best-of-3
            </button>
          )}
          <button onClick={() => { setSeries(NEW_SERIES); setPhase("setup"); }} className="px-5 py-3 rounded-xl border border-th bg-th-surface text-th-secondary font-display font-semibold">
            Change pool or settings
          </button>
        </div>
      </div>
    );
  }

  return null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-th bg-th-surface p-4">
      <h3 className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-3">{title}</h3>
      {children}
    </div>
  );
}

function SeriesBar({ series }: { series: Series }) {
  return (
    <div className="mb-4 flex items-center gap-3 text-xs font-display text-th-muted">
      <span className="text-th-primary font-semibold">Draft Match</span>
      <span>Best of 3 · Game {series.game + 1}</span>
      <span className="font-mono text-th-secondary">You {series.wins[YOU]} – {series.wins[CPU]} CPU</span>
    </div>
  );
}
