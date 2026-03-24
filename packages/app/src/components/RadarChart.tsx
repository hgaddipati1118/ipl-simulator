/**
 * Octagonal radar/spider chart for player attributes.
 * Batting attributes on the left, bowling on the right, clutch at top.
 * Pure SVG — no external library.
 */

interface RadarChartProps {
  attributes: { label: string; value: number }[];
  teamColor?: string;
  size?: number;
}

export function RadarChart({ attributes, teamColor = "#FF822A", size = 220 }: RadarChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 24; // padding for labels
  const n = attributes.length;

  // Generate points for a regular polygon at a given radius
  const polygonPoints = (radius: number) =>
    Array.from({ length: n }, (_, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2; // start from top
      return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
    });

  // Grid rings at 25%, 50%, 75%, 100%
  const rings = [0.25, 0.5, 0.75, 1.0];

  // Data points based on attribute values (0-99 scale)
  const dataPoints = attributes.map((attr, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const r = (attr.value / 99) * maxR;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });

  // Label positions (slightly outside the chart)
  const labelPoints = attributes.map((_, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const r = maxR + 16;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  const pointsToPath = (pts: number[][]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ") + "Z";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      {/* Grid rings */}
      {rings.map((pct) => (
        <polygon
          key={pct}
          points={polygonPoints(maxR * pct).map(p => p.join(",")).join(" ")}
          fill="none"
          stroke="var(--th-border)"
          strokeWidth={pct === 1 ? 1 : 0.5}
          opacity={pct === 0.5 ? 0.6 : 0.3}
        />
      ))}

      {/* Axis lines */}
      {Array.from({ length: n }, (_, i) => {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        const x2 = cx + maxR * Math.cos(angle);
        const y2 = cy + maxR * Math.sin(angle);
        return (
          <line key={i} x1={cx} y1={cy} x2={x2} y2={y2} stroke="var(--th-border)" strokeWidth={0.5} opacity={0.3} />
        );
      })}

      {/* Data area fill */}
      <polygon
        points={dataPoints.map(p => p.join(",")).join(" ")}
        fill={teamColor}
        fillOpacity={0.15}
        stroke={teamColor}
        strokeWidth={2}
        strokeOpacity={0.8}
      />

      {/* Data points */}
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={teamColor} opacity={0.9} />
      ))}

      {/* Labels */}
      {labelPoints.map((pos, i) => (
        <text
          key={i}
          x={pos.x}
          y={pos.y}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-[var(--th-text-muted)]"
          style={{ fontSize: "9px", fontFamily: "Outfit, system-ui", fontWeight: 500 }}
        >
          {attributes[i].label}
        </text>
      ))}

      {/* Center value labels (just the numbers at each data point) */}
      {dataPoints.map((p, i) => {
        // Only show value if it's high enough to not overlap the center
        const val = attributes[i].value;
        if (val < 20) return null;
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        const nudge = 12;
        return (
          <text
            key={`v${i}`}
            x={p[0] + nudge * Math.cos(angle)}
            y={p[1] + nudge * Math.sin(angle)}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-[var(--th-text-secondary)]"
            style={{ fontSize: "8px", fontFamily: "JetBrains Mono, monospace", fontWeight: 600 }}
          >
            {val}
          </text>
        );
      })}
    </svg>
  );
}
