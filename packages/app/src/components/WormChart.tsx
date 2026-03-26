/**
 * Reusable worm (run progression) chart for cricket matches.
 * Shows over-by-over cumulative run totals for both innings.
 * Pure SVG — no external library.
 */

import type { DetailedBallEvent } from "@ipl-sim/engine";

interface WormChartTeam {
  id: string;
  shortName: string;
  primaryColor: string;
}

interface WormChartProps {
  innings1BallLog: DetailedBallEvent[];
  innings2BallLog: DetailedBallEvent[];
  battingFirstTeam: WormChartTeam;
  bowlingFirstTeam: WormChartTeam;
  /** Optional: compact mode for smaller rendering (default false) */
  compact?: boolean;
}

/** Build per-over cumulative run totals from a ball log */
function buildOverData(ballLog: DetailedBallEvent[]): number[] {
  if (ballLog.length === 0) return [];
  const overs: number[] = [];
  let maxOver = 0;
  for (const b of ballLog) {
    if (b.over + 1 > maxOver) maxOver = b.over + 1;
  }
  for (let o = 0; o < maxOver; o++) {
    const ballsInOver = ballLog.filter(b => b.over === o);
    const lastBall = ballsInOver[ballsInOver.length - 1];
    overs.push(lastBall ? lastBall.scoreSoFar : (overs.length > 0 ? overs[overs.length - 1] : 0));
  }
  return overs;
}

export function WormChart({
  innings1BallLog,
  innings2BallLog,
  battingFirstTeam,
  bowlingFirstTeam,
  compact = false,
}: WormChartProps) {
  const inn1Data = buildOverData(innings1BallLog);
  const inn2Data = buildOverData(innings2BallLog);

  if (inn1Data.length === 0 && inn2Data.length === 0) return null;

  const maxOvers = Math.max(inn1Data.length, inn2Data.length, 1);
  const maxRuns = Math.max(...inn1Data, ...inn2Data, 1);

  const W = compact ? 280 : 500;
  const H = compact ? 140 : 200;
  const padL = compact ? 28 : 36;
  const padR = compact ? 8 : 12;
  const padT = compact ? 8 : 12;
  const padB = compact ? 20 : 24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const x = (over: number) => padL + (over / maxOvers) * chartW;
  const y = (runs: number) => padT + chartH - (runs / maxRuns) * chartH;

  const toPath = (data: number[]) => {
    if (data.length === 0) return "";
    return data.map((r, i) => `${i === 0 ? "M" : "L"}${x(i + 1).toFixed(1)},${y(r).toFixed(1)}`).join(" ");
  };

  // Y-axis gridlines
  const yTicks: number[] = [];
  const step = maxRuns > 200 ? 50 : maxRuns > 100 ? 25 : maxRuns > 50 ? 20 : 10;
  for (let v = step; v <= maxRuns; v += step) yTicks.push(v);

  const fontSize = compact ? 7 : 9;
  const labelFontSize = compact ? 10 : 11;
  const strokeW = compact ? 2 : 2.5;

  const containerClass = compact
    ? "bg-th-raised rounded-xl border border-th p-3"
    : "bg-th-surface rounded-xl border border-th p-4";

  return (
    <div className={containerClass}>
      <h3
        className={`uppercase tracking-wider text-th-muted font-semibold ${compact ? "mb-2 font-display" : "mb-3"}`}
        style={{ fontSize: labelFontSize }}
      >
        Run Worm
      </h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: compact ? 180 : 260 }}>
        {/* Grid */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} strokeWidth={0.5} style={{ stroke: "rgba(255,255,255,0.06)" }} />
            <text x={padL - 3} y={y(v) + 3} style={{ fill: "rgba(255,255,255,0.25)" }} fontSize={fontSize} textAnchor="end">{v}</text>
          </g>
        ))}
        {/* X axis labels */}
        {Array.from({ length: maxOvers }, (_, i) => i + 1)
          .filter(o => o % 5 === 0 || o === maxOvers)
          .map(o => (
            <text key={o} x={x(o)} y={H - 3} style={{ fill: "rgba(255,255,255,0.3)" }} fontSize={fontSize} textAnchor="middle">{o}</text>
          ))}
        {/* Innings 1 worm */}
        {inn1Data.length > 0 && (
          <path
            d={toPath(inn1Data)}
            fill="none"
            stroke={battingFirstTeam.primaryColor}
            strokeWidth={strokeW}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {/* Innings 2 worm */}
        {inn2Data.length > 0 && (
          <path
            d={toPath(inn2Data)}
            fill="none"
            stroke={bowlingFirstTeam.primaryColor}
            strokeWidth={strokeW}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="4 2"
          />
        )}
      </svg>
      {/* Legend */}
      <div className={`flex justify-center gap-4 ${compact ? "mt-1.5" : "mt-2"}`}>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 rounded" style={{ backgroundColor: battingFirstTeam.primaryColor }} />
          <span className={`text-th-muted ${compact ? "text-[10px] font-display" : "text-xs"}`}>
            {battingFirstTeam.shortName}{compact ? "" : " (1st inn)"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 rounded border-t border-dashed" style={{ borderColor: bowlingFirstTeam.primaryColor }} />
          <span className={`text-th-muted ${compact ? "text-[10px] font-display" : "text-xs"}`}>
            {bowlingFirstTeam.shortName}{compact ? "" : " (2nd inn)"}
          </span>
        </div>
      </div>
    </div>
  );
}
