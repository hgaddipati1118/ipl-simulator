/**
 * "Ratings over time" for one player: the real history (from the per-year CricketArchive ratings), the career so far
 * in the game, and the simulated future (median line, 50% and 80% bands) from the engine's progression model.
 * Pure SVG, like WormChart; the history file is fetched lazily.
 */

import { useEffect, useMemo, useState } from "react";
import type { Player, ProjectionPoint } from "@ipl-sim/engine";
import {
  buildChartModel, loadRatingHistory, realSeasonsFor, isWomanInHistory, projectionFor, PROJECTION_RUNS, PROJECTION_SEASONS,
  type RatingHistoryData, type RatingSeries, type ChartModel,
} from "../rating-history";

interface Props {
  player: Player;
  /** The game's season number (1 = the first season, where the real history ends) */
  seasonNumber: number;
  /** Which league's curves to use when the player is not in the history file */
  leagueGender: "male" | "female";
  /** The projection, when the parent already has it (otherwise simulated here) */
  projection?: ProjectionPoint[];
  /** Seasons to project and simulated careers per projection */
  seasons?: number;
  runs?: number;
  /** Supply the history instead of fetching it (tests, or a parent that already has it) */
  historyData?: RatingHistoryData | null;
}

const W = 640;
const H = 250;
const PAD = { l: 34, r: 12, t: 12, b: 28 };

const SERIES_LABEL: Record<RatingSeries, string> = { overall: "Overall", batting: "Batting", bowling: "Bowling" };

function pathOf(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function areaOf(upper: { x: number; y: number }[], lower: { x: number; y: number }[]): string {
  if (upper.length === 0) return "";
  const pts = [...upper, ...[...lower].reverse()];
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
}

export function ChartSvg({ model, label }: { model: ChartModel; label: string }) {
  const x = (age: number) => PAD.l + ((age - model.xMin) / Math.max(1, model.xMax - model.xMin)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - model.yMin) / Math.max(1, model.yMax - model.yMin)) * (H - PAD.t - PAD.b);
  const pt = (age: number, v: number) => ({ x: x(age), y: y(v) });

  const yTicks: number[] = [];
  for (let v = model.yMin; v <= model.yMax; v += 5) yTicks.push(v);
  const xTicks: number[] = [];
  for (let a = Math.ceil(model.xMin); a <= model.xMax; a++) if ((a - Math.ceil(model.xMin)) % 2 === 0) xTicks.push(a);

  const band = model.projection;
  const median = band.map(b => pt(b.age, b.p50));
  const nowAge = model.career[model.career.length - 1]?.age;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={label} data-testid="ratings-over-time-chart">
      {yTicks.map(v => (
        <g key={`y${v}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-th-faint" strokeOpacity={0.15} />
          <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize={9} className="fill-current text-th-faint">{v}</text>
        </g>
      ))}
      {xTicks.map(a => (
        <text key={`x${a}`} x={x(a)} y={H - PAD.b + 14} textAnchor="middle" fontSize={9} className="fill-current text-th-faint">{a}</text>
      ))}
      <text x={W - PAD.r} y={H - 3} textAnchor="end" fontSize={9} className="fill-current text-th-faint">age</text>

      {nowAge !== undefined && (
        <line x1={x(nowAge)} x2={x(nowAge)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" className="text-th-faint" strokeOpacity={0.35} strokeDasharray="2 3" />
      )}

      {band.length > 1 && (
        <>
          <path d={areaOf(band.map(b => pt(b.age, b.p90)), band.map(b => pt(b.age, b.p10)))} fill="#FF822A" fillOpacity={0.12} data-testid="band-80" />
          <path d={areaOf(band.map(b => pt(b.age, b.p75)), band.map(b => pt(b.age, b.p25)))} fill="#FF822A" fillOpacity={0.22} data-testid="band-50" />
          <path d={pathOf(median)} fill="none" stroke="#FF822A" strokeWidth={2} strokeDasharray="5 4" data-testid="projection-median" />
        </>
      )}
      {model.real.length > 0 && (
        <path d={pathOf([...model.real, model.career[0]].map(p => pt(p.age, p.value)))} fill="none" stroke="#6C8CFF" strokeWidth={2} data-testid="real-history" />
      )}
      {model.real.map(p => <circle key={`r${p.age}`} cx={x(p.age)} cy={y(p.value)} r={2.5} fill="#6C8CFF" />)}
      {model.career.length > 1 && (
        <path d={pathOf(model.career.map(p => pt(p.age, p.value)))} fill="none" stroke="#2FBF71" strokeWidth={2.5} data-testid="career-history" />
      )}
      {model.career.map(p => <circle key={`c${p.age}`} cx={x(p.age)} cy={y(p.value)} r={3} fill="#2FBF71" />)}
    </svg>
  );
}

export function RatingsOverTime({ player, seasonNumber, leagueGender, projection: given, seasons = PROJECTION_SEASONS, runs = PROJECTION_RUNS, historyData }: Props) {
  const [fetched, setFetched] = useState<RatingHistoryData | null>(null);
  const [loaded, setLoaded] = useState(historyData !== undefined);
  useEffect(() => {
    if (historyData !== undefined) return;
    let alive = true;
    loadRatingHistory().then(d => { if (alive) { setFetched(d); setLoaded(true); } });
    return () => { alive = false; };
  }, [historyData]);
  const data = historyData !== undefined ? historyData : fetched;

  const main: RatingSeries = player.battingOvr >= player.bowlingOvr ? "batting" : "bowling";
  const [series, setSeries] = useState<RatingSeries>(main);

  const woman = isWomanInHistory(data, player.sourceId ?? player.id);
  const gender = (woman ?? leagueGender === "female") ? "female" : "male";
  // Deterministic per player and state, so the chart does not jitter between renders
  const projection = useMemo(
    () => given ?? projectionFor(player, seasonNumber, gender, seasons, runs),
    // keyed by the ratings that drive the projection
    [given, player.id, player.age, player.battingOvr, player.bowlingOvr, player.potential, seasonNumber, seasons, runs, gender],
  );
  const real = useMemo(() => realSeasonsFor(data, player.sourceId ?? player.id), [data, player.id, player.sourceId]);

  const model = useMemo(() => buildChartModel({
    series, age: player.age, seasonNumber, ratingHistory: player.ratingHistory,
    current: { overall: player.overall, batting: player.battingOvr, bowling: player.bowlingOvr },
    real, projection,
  }), [series, player.age, player.overall, player.battingOvr, player.bowlingOvr, player.ratingHistory, seasonNumber, real, projection]);

  const last = model.projection[model.projection.length - 1];
  const summary = last && model.projection.length > 1
    ? `${SERIES_LABEL[series]} rating projection: median ${Math.round(last.p50)} at age ${last.age} (80% of outcomes ${Math.round(last.p10)} to ${Math.round(last.p90)}), ${Math.round(last.active * 100)}% still playing.`
    : `${SERIES_LABEL[series]} rating, no projection (retirement age).`;

  return (
    <div className="mt-4 pt-4 border-t border-th" data-testid="ratings-over-time">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-th-faint text-[10px] uppercase tracking-wider font-display font-semibold">Ratings over time</div>
        <div className="flex gap-1" role="group" aria-label="Rating to chart">
          {(["overall", "batting", "bowling"] as RatingSeries[]).map(s => (
            <button
              key={s}
              type="button"
              aria-pressed={series === s}
              onClick={() => setSeries(s)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-display font-semibold border transition-colors ${series === s ? "border-orange-500/50 bg-orange-500/15 text-orange-400" : "border-th text-th-muted hover:text-th-secondary"}`}
            >
              {SERIES_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <ChartSvg model={model} label={summary} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-th-faint font-display mt-1">
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#6C8CFF]" />Real history{model.real.length === 0 && loaded ? " (none on record)" : ""}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#2FBF71]" />Career in the game</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#FF822A]" />Projected median, 50% and 80% bands</span>
      </div>
      <p className="text-xs text-th-muted mt-2" data-testid="ratings-over-time-summary">{summary}</p>
      {model.shift !== 0 && model.real.length > 0 && (
        <p className="text-[10px] text-th-faint mt-1">Real history is shown {model.shift > 0 ? "+" : ""}{model.shift} to meet the game&apos;s rating.</p>
      )}
    </div>
  );
}
