/**
 * International series: pick two nations (men or women), a format (SERIES_FORMATS: ODI, T20I; Test plugs in there), 1, 3
 * or 5 matches, the venue and whether you captain a side or watch; then play each match live or simulate it, with series
 * score, scorecards, series stats and player of the series. Logic: ../international.ts. The series is kept in its own
 * localStorage key (career saves, presets and multiplayer are untouched).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toDraftPlayer, type MatchState, type Player, type Team } from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import {
  SERIES_FORMATS, SERIES_SEASON_KEY, addResult, autoLineup, createSeries, homeGrounds, lineupProblems, loadSeries, matchContext,
  matchName, nextMatchNumber, saveSeries, seriesFormat, seriesNations, seriesScore, seriesSquads, seriesStats, simulateRestOfSeries,
  simulateSeriesMatch, teamsForMatch, venueFor,
  type IntlSeries, type SeriesGender, type SeriesHost, type SeriesLineup, type SeriesMatchRecord,
} from "../international";
import { loadFormatRatings } from "../format-ratings";
import { LiveMatchPage } from "./LiveMatchPage";
import { BattingCard, BowlingCard } from "./MatchPage";
import { LineupEditor } from "../components/DraftMatchParts";
import { WormChart } from "../components/WormChart";
import { TeamBadge } from "../components/TeamBadge";
import { clearInProgressMatch } from "../match-db";
import { buildLiveMatchStorageKey, getActiveSlotId } from "../storage";
import { ovrColorClass, roleLabel, oversLabel } from "../ui-utils";

type View =
  | { kind: "setup" }
  | { kind: "hub" }
  | { kind: "lineup" }
  | { kind: "live"; n: number; state: MatchState | null }
  | { kind: "scorecard"; n: number };

/** Clear any saved in-progress live match of the series namespace (a new series reuses the match numbers) */
async function clearSeriesLiveSaves(): Promise<void> {
  const slot = getActiveSlotId();
  for (let n = 0; n < 7; n++) {
    try { await clearInProgressMatch(slot, SERIES_SEASON_KEY, n); } catch { /* none saved */ }
    try { localStorage.removeItem(buildLiveMatchStorageKey(slot, SERIES_SEASON_KEY, n)); } catch { /* unavailable */ }
  }
}

export function InternationalPage() {
  const navigate = useNavigate();
  const [series, setSeries] = useState<IntlSeries | null>(() => loadSeries());
  // the ODI / Test ratings file (undefined while loading; null if unavailable: everyone then plays on T20 ratings)
  const [file, setFile] = useState<FormatRatingsFile | null | undefined>(undefined);
  const [view, setView] = useState<View>(() => {
    const s = loadSeries();
    if (!s) return { kind: "setup" };
    return s.liveMatch !== undefined ? { kind: "live", n: s.liveMatch, state: null } : { kind: "hub" };
  });

  useEffect(() => { loadFormatRatings().then(f => setFile(f ?? null)); }, []);

  const update = (s: IntlSeries | null) => { setSeries(s); saveSeries(s); };
  const squads = useMemo(() => (series && file !== undefined ? seriesSquads(series, file) : null), [series?.id, file]); // eslint-disable-line react-hooks/exhaustive-deps

  if (file === undefined) {
    return <div className="max-w-md mx-auto px-4 py-20 text-center text-th-muted font-display animate-pulse">Loading ratings...</div>;
  }

  if (view.kind === "setup" || !series || !squads) {
    return (
      <SeriesSetup
        file={file}
        existing={series}
        onResume={() => setView({ kind: "hub" })}
        onStart={async s => { await clearSeriesLiveSaves(); update(s); setView({ kind: "hub" }); }}
        onBack={() => navigate("/")}
      />
    );
  }

  const def = seriesFormat(series.format);
  const userTeamId = series.userSide !== null ? series.sides[series.userSide].id : null;

  if (view.kind === "lineup" && series.userSide !== null) {
    const squad = squads[series.userSide];
    return (
      <LineupScreen
        series={series}
        squad={squad}
        initial={series.lineup ?? autoLineup(squad, def.rules?.(series.gender))}
        onCancel={() => setView({ kind: "hub" })}
        onSave={lineup => { update({ ...series, lineup }); setView({ kind: "hub" }); }}
      />
    );
  }

  if (view.kind === "live") {
    const n = view.n;
    const { home, away, venue } = teamsForMatch(series, n, squads);
    return (
      <div>
        {/* above the live page's decision modals, so the series is reachable at any moment */}
        <div className="relative z-[60] max-w-6xl mx-auto px-4 pt-4 flex items-center gap-3">
          <button onClick={() => setView({ kind: "hub" })} className="text-xs font-display text-th-muted hover:text-th-primary">&larr; Series</button>
          <span className="text-xs font-display text-th-muted">{matchName(series, n)} · {venue.name}</span>
        </div>
        <LiveMatchPage
          key={`${series.id}-${n}`}
          seasonNumber={SERIES_SEASON_KEY}
          matchState={view.state}
          matchIndex={n}
          userTeamId={userTeamId}
          teams={[home, away] as Team[]}
          previousResults={[]}
          headerLabel={`${matchName(series, n)} · ${series.sides[0].name} v ${series.sides[1].name}`}
          onMatchComplete={state => {
            if (series.results.some(r => r.n === n)) return;
            const rec = def.live!.finish(state, { venue, seed: matchContext(series, n, squads).seed });
            update(addResult(series, { ...rec, n }));
          }}
          onContinue={() => setView({ kind: "hub" })}
          onViewScorecard={() => setView({ kind: "scorecard", n })}
        />
      </div>
    );
  }

  if (view.kind === "scorecard") {
    const rec = series.results.find(r => r.n === view.n);
    if (rec) return <SeriesScorecard series={series} rec={rec} onBack={() => setView({ kind: "hub" })} />;
  }

  return (
    <SeriesHub
      series={series}
      squads={squads}
      onPlayLive={n => {
        const ctx = matchContext(series, n, squads);
        const state = def.live!.create(ctx, userTeamId) as MatchState;
        update({ ...series, liveMatch: n });
        setView({ kind: "live", n, state });
      }}
      onResumeLive={n => setView({ kind: "live", n, state: null })}
      onAbandonLive={() => update({ ...series, liveMatch: undefined })}
      onSimulate={n => update(simulateSeriesMatch({ ...series, liveMatch: undefined }, squads, n))}
      onSimRest={() => update(simulateRestOfSeries({ ...series, liveMatch: undefined }, squads))}
      onLineup={() => setView({ kind: "lineup" })}
      onScorecard={n => setView({ kind: "scorecard", n })}
      onNewSeries={() => {
        if (series.results.length < series.length && seriesScore(series).done === false && !confirm("Abandon this series and start a new one?")) return;
        setView({ kind: "setup" });
      }}
    />
  );
}

// ── Setup ───────────────────────────────────────────────────────────────

function SeriesSetup({ file, existing, onStart, onResume, onBack }: {
  file: FormatRatingsFile | null;
  existing: IntlSeries | null;
  onStart: (s: IntlSeries) => void;
  onResume: () => void;
  onBack: () => void;
}) {
  const [gender, setGender] = useState<SeriesGender>("men");
  const nations = useMemo(() => seriesNations(gender), [gender]);
  const [a, setA] = useState("India");
  const [b, setB] = useState("Australia");
  const [format, setFormat] = useState(SERIES_FORMATS[0].id);
  const def = seriesFormat(format);
  const [length, setLength] = useState(3);
  const [host, setHost] = useState<SeriesHost>("a");
  const [role, setRole] = useState<"a" | "b" | "watch">("a");
  const [busy, setBusy] = useState(false);

  // keep the picks valid when the gender changes
  useEffect(() => {
    const names = nations.map(n => n.country);
    if (!names.includes(a)) setA(names[0]);
    if (!names.includes(b) || b === a) setB(names.find(n => n !== (names.includes(a) ? a : names[0])) ?? names[1]);
  }, [nations]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!def.lengths.includes(length)) setLength(def.lengths[0]); }, [def, length]);

  const groundsA = homeGrounds(a).length, groundsB = homeGrounds(b).length;
  const start = () => {
    if (a === b) return;
    setBusy(true);
    // building squads and the first match is quick, but let the button repaint first
    setTimeout(() => {
      onStart(createSeries({ format, gender, nations: [a, b], length, host, userSide: role === "watch" ? null : role === "a" ? 0 : 1 }, file));
      setBusy(false);
    }, 0);
  };

  const chip = (on: boolean) => `px-3 py-2 rounded-xl border text-sm font-display font-semibold transition-colors ${on ? "border-orange-500/40 bg-orange-500/[0.08] text-orange-300" : "border-th bg-th-surface text-th-secondary hover:bg-th-hover"}`;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 animate-fade-in" data-testid="series-setup">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-display font-extrabold tracking-tight mb-2">
          <span className="text-gradient-orange">International</span><span className="text-th-primary ml-3">Series</span>
        </h1>
        <p className="text-th-muted font-display">Two nations, their real players on their format ratings. Play every match live or simulate it.</p>
      </div>

      {existing && (
        <button onClick={onResume} data-testid="series-resume"
          className="w-full mb-5 text-left rounded-2xl border border-orange-500/30 bg-orange-500/[0.06] p-4 hover:bg-orange-500/[0.1]">
          <div className="text-[10px] uppercase tracking-wider font-display font-semibold text-orange-400">Resume series</div>
          <div className="text-sm font-display font-semibold text-th-primary mt-1">{existing.sides[0].name} v {existing.sides[1].name} · {seriesFormat(existing.format).label}</div>
          <div className="text-xs text-th-muted font-display">{seriesScore(existing).text}</div>
        </button>
      )}

      <div className="space-y-5">
        <Section title="Teams">
          <div className="flex gap-2 mb-3">
            {(["men", "women"] as const).map(g => (
              <button key={g} onClick={() => setGender(g)} className={chip(gender === g)} data-testid={`series-gender-${g}`}>{g === "men" ? "Men" : "Women"}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-display text-th-muted">
            <select value={a} onChange={e => setA(e.target.value)} data-testid="series-nation-a" className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-th-secondary">
              {nations.map(n => <option key={n.country} value={n.country}>{n.country}</option>)}
            </select>
            <button onClick={() => { setA(b); setB(a); }} className="px-2 py-1 rounded-lg border border-th text-th-muted hover:text-th-primary" title="Swap">v</button>
            <select value={b} onChange={e => setB(e.target.value)} data-testid="series-nation-b" className="bg-th-raised border border-th rounded-lg px-2 py-1.5 text-th-secondary">
              {nations.map(n => <option key={n.country} value={n.country}>{n.country}</option>)}
            </select>
            {a === b && <span className="text-amber-400">Pick two different nations</span>}
          </div>
        </Section>

        <Section title="Format">
          <div className="grid sm:grid-cols-2 gap-2">
            {SERIES_FORMATS.map(f => (
              <button key={f.id} onClick={() => setFormat(f.id)} data-testid={`series-format-${f.id}`}
                className={`text-left p-3 rounded-xl border transition-colors ${format === f.id ? "border-orange-500/40 bg-orange-500/[0.07]" : "border-th bg-th-surface hover:bg-th-hover"}`}>
                <div className="text-sm font-display font-semibold text-th-primary">{f.label}</div>
                <div className="text-[11px] text-th-muted">{f.desc}{f.ratingFormat !== "t20" ? ` · ${f.label} ratings` : ""}</div>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-[11px] text-th-muted font-display mr-1">Matches</span>
            {def.lengths.map(n => (
              <button key={n} onClick={() => setLength(n)} className={chip(length === n)} data-testid={`series-length-${n}`}>{n}</button>
            ))}
          </div>
        </Section>

        <Section title="Venue and your role">
          <div className="flex flex-wrap gap-2 mb-3">
            <button onClick={() => setHost("a")} className={chip(host === "a")} data-testid="series-host-a">In {a}{groundsA ? "" : " (neutral grounds)"}</button>
            <button onClick={() => setHost("b")} className={chip(host === "b")} data-testid="series-host-b">In {b}{groundsB ? "" : " (neutral grounds)"}</button>
            <button onClick={() => setHost("neutral")} className={chip(host === "neutral")} data-testid="series-host-neutral">Neutral venue</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setRole("a")} className={chip(role === "a")} data-testid="series-role-a">Captain {a}</button>
            <button onClick={() => setRole("b")} className={chip(role === "b")} data-testid="series-role-b">Captain {b}</button>
            <button onClick={() => setRole("watch")} className={chip(role === "watch")} data-testid="series-role-watch">Watch</button>
          </div>
          <p className="text-[11px] text-th-faint font-display mt-2">
            A captain picks his XI and batting order before each match and makes the decisions in live matches (bowling changes, reviews).
            {file === null ? " ODI and Test ratings are unavailable: everyone plays on his T20 ratings." : ""}
          </p>
        </Section>

        <div className="grid sm:grid-cols-2 gap-3">
          <button onClick={start} disabled={busy || a === b} data-testid="series-start"
            className="px-5 py-4 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-50 text-white font-display font-semibold rounded-xl shadow-lg shadow-orange-500/20">
            {busy ? "Picking squads..." : `Start the ${length === 1 ? "match" : "series"}`}
          </button>
          <button onClick={onBack} className="px-5 py-4 bg-th-surface border border-th hover:bg-th-hover text-th-primary font-display font-semibold rounded-xl">
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Hub ─────────────────────────────────────────────────────────────────

function SeriesHub({ series, squads, onPlayLive, onResumeLive, onAbandonLive, onSimulate, onSimRest, onLineup, onScorecard, onNewSeries }: {
  series: IntlSeries;
  squads: [Player[], Player[]];
  onPlayLive: (n: number) => void;
  onResumeLive: (n: number) => void;
  onAbandonLive: () => void;
  onSimulate: (n: number) => void;
  onSimRest: () => void;
  onLineup: () => void;
  onScorecard: (n: number) => void;
  onNewSeries: () => void;
}) {
  const def = seriesFormat(series.format);
  const score = seriesScore(series);
  const next = nextMatchNumber(series);
  const stats = useMemo(() => seriesStats(series), [series]);
  const [a, b] = series.sides;
  const userSide = series.userSide !== null ? series.sides[series.userSide] : null;
  const userXI = series.userSide !== null
    ? (series.lineup ?? autoLineup(squads[series.userSide], def.rules?.(series.gender))).order
      .map(id => squads[series.userSide!].find(p => p.id === id)).filter((p): p is Player => !!p)
    : [];
  const hostName = series.host === "neutral" ? "neutral venues" : `in ${series.sides[series.host === "a" ? 0 : 1].country}`;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in space-y-5" data-testid="series-hub">
      {/* Header */}
      <div className="rounded-2xl border border-th overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${a.primaryColor}22 0%, transparent 45%, ${b.primaryColor}22 100%)` }}>
        <div className="h-1 flex"><div className="flex-1" style={{ background: a.primaryColor }} /><div className="flex-1" style={{ background: b.primaryColor }} /></div>
        <div className="p-5 sm:p-6">
          <div className="text-[10px] uppercase tracking-widest text-th-muted font-display text-center">
            {series.length === 1 ? "One-off" : `${series.length}-match`} {def.label} {series.length === 1 ? "match" : "series"} · {series.gender === "women" ? "Women" : "Men"} · {hostName}
          </div>
          <div className="flex items-center justify-center gap-6 sm:gap-10 mt-4">
            {[a, b].map((s, i) => (
              <div key={s.id} className="text-center">
                <TeamBadge teamId={s.id} shortName={s.shortName} primaryColor={s.primaryColor} size="lg" />
                <div className="mt-2 font-display font-bold text-th-primary text-sm sm:text-base">{s.name}</div>
                <div className="text-3xl font-display font-extrabold text-th-primary stat-num mt-1" data-testid={`series-wins-${i}`}>{score.wins[i]}</div>
              </div>
            ))}
          </div>
          <div className="text-center mt-3 text-lg font-display font-bold text-gradient-orange" data-testid="series-score">{score.text}</div>
          {userSide && <div className="text-center text-[11px] text-th-muted font-display mt-1">You captain {userSide.name}</div>}
        </div>
      </div>

      {/* Matches */}
      <Section title="Matches">
        <div className="space-y-2">
          {Array.from({ length: series.length }, (_, n) => {
            const rec = series.results.find(r => r.n === n);
            const venue = venueFor(series, n);
            const isNext = next === n;
            const live = series.liveMatch === n;
            return (
              <div key={n} className={`rounded-xl border p-3 ${isNext ? "border-orange-500/30 bg-orange-500/[0.04]" : "border-th bg-th-raised"}`} data-testid={`series-match-${n}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-display font-semibold text-th-primary">{matchName(series, n)}</span>
                  <span className="text-[11px] text-th-muted font-display">{venue.name}{venue.city && venue.city !== venue.name ? `, ${venue.city}` : ""}</span>
                  <span className="flex-1" />
                  {rec && (
                    <button onClick={() => onScorecard(n)} data-testid={`series-scorecard-${n}`} className="text-xs font-display text-orange-400 hover:text-orange-300">Scorecard</button>
                  )}
                </div>
                {rec ? (
                  <div className="mt-1 text-xs font-display text-th-secondary">
                    <span className="font-semibold">{rec.result}</span>
                    <span className="text-th-faint"> · {rec.innings.map(i => `${i.battingTeamName.replace(/ Women$/, "")} ${i.totalRuns}/${i.totalWickets} (${oversLabel(i.totalOvers)})`).join(", ")}</span>
                    {rec.potm?.playerName && <span className="text-th-faint"> · POTM {rec.potm.playerName}</span>}
                    <span className="text-th-faint"> · {rec.mode === "live" ? "played live" : "simulated"}</span>
                  </div>
                ) : !isNext ? (
                  <div className="mt-1 text-xs font-display text-th-faint">{score.done ? "Not played (the series was decided)" : "To come"}</div>
                ) : live ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => onResumeLive(n)} data-testid="series-resume-live" className="px-4 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-xs font-display font-semibold">Resume live match</button>
                    <button onClick={onAbandonLive} className="px-4 py-2 rounded-xl border border-th bg-th-surface text-xs font-display font-semibold text-th-secondary">Abandon it</button>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {def.live && (
                      <button onClick={() => onPlayLive(n)} data-testid="series-play-live" className="px-4 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-xs font-display font-semibold">Play live</button>
                    )}
                    <button onClick={() => onSimulate(n)} data-testid="series-sim-match" className="px-4 py-2 rounded-xl border border-th bg-th-surface text-xs font-display font-semibold text-th-primary hover:bg-th-hover">Simulate</button>
                    {series.length - series.results.length > 1 && (
                      <button onClick={onSimRest} data-testid="series-sim-rest" className="px-4 py-2 rounded-xl border border-th bg-th-surface text-xs font-display font-semibold text-th-secondary hover:bg-th-hover">Simulate the rest</button>
                    )}
                    {userSide && (
                      <button onClick={onLineup} data-testid="series-edit-xi" className="px-4 py-2 rounded-xl border border-th bg-th-surface text-xs font-display font-semibold text-th-secondary hover:bg-th-hover">Pick {userSide.shortName} XI</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {userSide && next !== null && (
          <p className="text-[11px] text-th-muted font-display mt-3" data-testid="series-user-xi">
            <span className="text-th-secondary font-semibold">{userSide.shortName} XI{series.lineup ? "" : " (auto)"}:</span> {userXI.map(p => p.name).join(", ")}
          </p>
        )}
      </Section>

      {/* Stats */}
      {series.results.length > 0 && (
        <Section title={score.done ? "Series stats" : "Series stats so far"}>
          {stats.playerOfSeries && (
            <div className="mb-3 text-sm font-display text-th-secondary" data-testid="series-pots">
              {score.done ? "Player of the series" : "Leading the way"}: <span className="text-th-primary font-semibold">{stats.playerOfSeries.name}</span>
              <span className="text-th-muted"> ({stats.playerOfSeries.summary})</span>
            </div>
          )}
          <div className="grid lg:grid-cols-2 gap-4">
            <StatTable
              title="Most runs"
              head={["Batter", "Inn", "Runs", "HS", "Avg", "SR", "100/50"]}
              rows={stats.batting.slice(0, 8).map(l => [
                <PlayerName key="n" name={l.name} side={series.sides.find(s => s.id === l.sideId)?.shortName} />,
                l.innings, <b key="r">{l.runs}</b>, `${l.high}${l.highNotOut ? "*" : ""}`,
                l.average !== null ? l.average.toFixed(1) : "-", l.strikeRate !== null ? l.strikeRate.toFixed(1) : "-", `${l.hundreds}/${l.fifties}`,
              ])}
            />
            <StatTable
              title="Most wickets"
              head={["Bowler", "Overs", "Wkts", "Runs", "Avg", "Econ", "Best"]}
              rows={stats.bowling.filter(l => l.balls > 0).slice(0, 8).map(l => [
                <PlayerName key="n" name={l.name} side={series.sides.find(s => s.id === l.sideId)?.shortName} />,
                `${Math.floor(l.balls / 6)}${l.balls % 6 ? `.${l.balls % 6}` : ""}`, <b key="w">{l.wickets}</b>, l.runs,
                l.average !== null ? l.average.toFixed(1) : "-", l.economy !== null ? l.economy.toFixed(2) : "-", l.best,
              ])}
            />
          </div>
        </Section>
      )}

      <div className="flex flex-wrap gap-3">
        <button onClick={onNewSeries} data-testid="series-new" className="px-5 py-3 rounded-xl border border-th bg-th-surface text-th-secondary font-display font-semibold text-sm hover:bg-th-hover">
          New series
        </button>
      </div>
    </div>
  );
}

function PlayerName({ name, side }: { name: string; side?: string }) {
  return <span className="text-th-primary">{name}{side && <span className="text-th-faint text-[10px] ml-1">{side}</span>}</span>;
}

function StatTable({ title, head, rows }: { title: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="rounded-xl bg-th-raised p-3 overflow-x-auto">
      <div className="text-xs font-display font-semibold text-th-primary mb-2">{title}</div>
      <table className="w-full text-[11px] font-display">
        <thead>
          <tr className="text-th-faint">
            {head.map((h, i) => <th key={h} scope="col" className={`font-medium pb-1 ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-th text-th-secondary">
              {r.map((c, j) => <td key={j} className={`py-1 ${j === 0 ? "text-left" : "text-right font-mono"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Lineup ──────────────────────────────────────────────────────────────

function LineupScreen({ series, squad, initial, onSave, onCancel }: {
  series: IntlSeries;
  squad: Player[];
  initial: SeriesLineup;
  onSave: (l: SeriesLineup) => void;
  onCancel: () => void;
}) {
  const [xi, setXi] = useState<string[]>(initial.xi);
  const side = series.sides[series.userSide!];
  const fmt = seriesFormat(series.format);
  const problems = lineupProblems(squad, { xi, order: xi });
  const chosen = squad.filter(p => xi.includes(p.id));
  // keep the saved batting order for the players still in the XI, the newcomers after them
  const orderSeed = [...initial.order.filter(id => xi.includes(id)), ...xi.filter(id => !initial.order.includes(id))];
  const draftPlayers = orderSeed.map(id => chosen.find(p => p.id === id)!).filter(Boolean).map(toDraftPlayer);
  const toggle = (id: string) => setXi(x => (x.includes(id) ? x.filter(i => i !== id) : x.length < 11 ? [...x, id] : x));

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 animate-fade-in" data-testid="series-lineup">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onCancel} className="text-xs font-display text-th-muted hover:text-th-primary">&larr; Series</button>
        <h2 className="text-lg font-display font-bold text-th-primary">{side.name} XI</h2>
        <span className="text-xs text-th-muted font-display">{fmt.label} ratings · {xi.length}/11 picked</span>
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-th bg-th-surface p-4">
          <h3 className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-2">Squad</h3>
          <div className="space-y-1">
            {squad.map(p => {
              const on = xi.includes(p.id);
              return (
                <label key={p.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer ${on ? "bg-orange-500/[0.08]" : "bg-th-raised"}`} data-testid="series-squad-player">
                  <input type="checkbox" checked={on} onChange={() => toggle(p.id)} className="accent-orange-500" />
                  <span className={`w-6 font-mono ${ovrColorClass(p.overall)}`}>{p.overall}</span>
                  <span className="flex-1 truncate font-display text-th-primary">
                    {p.name}{p.isWicketKeeper && <span className="text-cyan-400/80 text-[9px] ml-1">WK</span>}
                  </span>
                  <span className="text-[10px] text-th-faint w-20 truncate">{roleLabel(p.role)}</span>
                  <span className="text-[10px] text-th-muted font-mono w-16 text-right">{p.battingOvr} / {p.bowlingOvr}</span>
                </label>
              );
            })}
          </div>
          <p className="text-[10px] text-th-faint font-display mt-2">Overall, batting / bowling on {fmt.label} ratings.</p>
          {problems.length > 0 && <p className="text-amber-400 text-xs font-display mt-2">{problems.join(" · ")}</p>}
        </div>
        <div>
          {xi.length === 11 ? (
            <LineupEditor
              key={xi.slice().sort().join(",")}
              players={draftPlayers}
              confirmLabel="Save XI and batting order"
              disabled={problems.length > 0}
              onConfirm={l => onSave({ xi, order: l.battingOrder })}
            />
          ) : (
            <div className="rounded-2xl border border-th bg-th-surface p-5 text-sm text-th-muted font-display">Pick eleven players to set the batting order.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Scorecard ───────────────────────────────────────────────────────────

function SeriesScorecard({ series, rec, onBack }: { series: IntlSeries; rec: SeriesMatchRecord; onBack: () => void }) {
  const [tab, setTab] = useState(0);
  const sideOf = (id: string) => series.sides.find(s => s.id === id);
  const inn = rec.innings[tab];
  const bat1 = sideOf(rec.innings[0]?.battingTeamId ?? ""), bat2 = sideOf(rec.innings[1]?.battingTeamId ?? "");
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in" data-testid="series-scorecard">
      <button onClick={onBack} className="text-th-secondary hover:text-th-primary text-sm mb-4">&larr; Back to the series</button>
      <div className="rounded-2xl border border-th bg-th-surface p-5 mb-5">
        <div className="text-[10px] uppercase tracking-wider font-display text-th-muted">{matchName(series, rec.n)} · {rec.venue}</div>
        <h2 className="text-xl font-display font-bold text-gradient-orange mt-1" data-testid="series-scorecard-result">{rec.result}</h2>
        <div className="mt-2 grid sm:grid-cols-2 gap-1 text-sm font-display text-th-secondary">
          {rec.innings.map((i, k) => (
            <div key={k}><span className="text-th-primary font-semibold">{i.battingTeamName}</span> {i.totalRuns}/{i.totalWickets} <span className="text-th-muted">({oversLabel(i.totalOvers)})</span></div>
          ))}
        </div>
        <div className="mt-2 text-xs text-th-muted font-display">
          Toss: {rec.tossWinnerName} chose to {rec.tossDecision} first
          {rec.potm?.playerName && <> · Player of the match: <span className="text-th-primary">{rec.potm.playerName}</span>{rec.potm.reason ? ` (${rec.potm.reason})` : ""}</>}
        </div>
      </div>
      {rec.worm.length >= 2 && bat1 && bat2 && (
        <div className="mb-5">
          <WormChart innings1BallLog={[]} innings2BallLog={[]} overTotals={[rec.worm[0], rec.worm[1]]} totalOvers={seriesFormat(series.format).overs}
            battingFirstTeam={{ id: bat1.id, shortName: bat1.shortName, primaryColor: bat1.primaryColor }}
            bowlingFirstTeam={{ id: bat2.id, shortName: bat2.shortName, primaryColor: bat2.primaryColor }} />
        </div>
      )}
      <div className={`mb-5 grid gap-2 ${rec.innings.length > 2 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-1 sm:grid-cols-2"}`}>
        {rec.innings.map((i, k) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`series-innings-tab-${k}`}
            className={`rounded-lg px-4 py-3 text-left text-sm font-semibold transition-colors sm:text-center ${tab === k ? "bg-blue-600 text-white" : "bg-th-raised text-th-secondary hover:bg-th-hover hover:text-th-primary"}`}>
            <span className="block">{["1st", "2nd", "3rd", "4th"][k] ?? `${k + 1}th`} innings &mdash; {i.battingTeamName}</span>
            <span className="mt-1 block text-xs opacity-75">{i.totalRuns}/{i.totalWickets} ({oversLabel(i.totalOvers)})</span>
          </button>
        ))}
      </div>
      {inn && (
        <>
          <BattingCard innings={inn} plain />
          <BowlingCard innings={inn} plain />
          <div className="bg-th-surface rounded-xl border border-th p-4 mb-6 text-sm text-th-secondary">
            <span className="text-xs font-semibold text-th-muted uppercase tracking-wider mr-2">Extras</span>
            {inn.extras.total} (w {inn.extras.wides}, nb {inn.extras.noBalls}, lb {inn.extras.legByes}{inn.extras.byes ? `, b ${inn.extras.byes}` : ""}{inn.extras.penalty ? `, pen ${inn.extras.penalty}` : ""})
            {inn.fallOfWickets.length > 0 && (
              <div className="mt-2">
                <span className="text-xs font-semibold text-th-muted uppercase tracking-wider mr-2">Fall of wickets</span>
                {inn.fallOfWickets.join(", ")}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-th bg-th-surface p-4">
      <h3 className="text-[10px] uppercase tracking-wider font-display font-semibold text-th-muted mb-3">{title}</h3>
      {children}
    </div>
  );
}
