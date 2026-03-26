/** Calculate luminance from hex color (shared helper) */
function getLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Returns true if the color is "light" and needs dark text on top */
export function isLightColor(hex: string): boolean {
  return getLuminance(hex) > 0.55;
}

/** Returns true if the color is very dark (needs a visible border on dark bg) */
export function isDarkColor(hex: string): boolean {
  return getLuminance(hex) < 0.15;
}

/** Badge text color for a given team primary color */
export function badgeTextColor(primaryColor: string): string {
  return isLightColor(primaryColor) ? "#1a1a2e" : "#ffffff";
}

/** Badge border style — dark team colors need a visible ring */
export function badgeBorderStyle(primaryColor: string): string {
  if (isDarkColor(primaryColor)) return "1px solid rgba(255,255,255,0.15)";
  if (isLightColor(primaryColor)) return "none";
  return `1px solid ${primaryColor}60`;
}

/** Team color for labels — ensure readability on dark backgrounds */
export function teamLabelColor(primaryColor: string): string {
  if (isDarkColor(primaryColor)) return "#d1d5db";
  if (getLuminance(primaryColor) < 0.35) return primaryColor + "dd";
  return primaryColor;
}

/** OVR color class — 7-tier continuous gradient */
export function ovrColorClass(ovr: number): string {
  if (ovr >= 93) return "text-cyan-300";
  if (ovr >= 85) return "text-emerald-400";
  if (ovr >= 75) return "text-lime-400";
  if (ovr >= 65) return "text-yellow-400";
  if (ovr >= 51) return "text-amber-400";
  if (ovr >= 36) return "text-red-400";
  return "text-slate-500";
}

/** OVR background for badge style — 7-tier with elite glow */
export function ovrBgClass(ovr: number): string {
  if (ovr >= 93) return "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/20";
  if (ovr >= 85) return "bg-emerald-500/12 text-emerald-400";
  if (ovr >= 75) return "bg-lime-500/10 text-lime-400";
  if (ovr >= 65) return "bg-yellow-500/10 text-yellow-400";
  if (ovr >= 51) return "bg-amber-500/10 text-amber-400";
  if (ovr >= 36) return "bg-red-500/10 text-red-400";
  return "bg-slate-500/10 text-slate-500";
}

/** Short role label */
export function roleLabel(role: string): string {
  switch (role) {
    case "batsman": return "BAT";
    case "bowler": return "BWL";
    case "all-rounder": return "AR";
    case "wicket-keeper": return "WK";
    default: return role;
  }
}

/** Short bowling style abbreviation */
export function bowlingStyleLabel(style: string): string {
  const labels: Record<string, string> = {
    "right-arm-fast": "RF",
    "right-arm-fast-medium": "RFM",
    "right-arm-medium-fast": "RMF",
    "right-arm-medium": "RM",
    "right-arm-slow": "RS",
    "left-arm-fast": "LF",
    "left-arm-fast-medium": "LFM",
    "left-arm-medium-fast": "LMF",
    "left-arm-medium": "LM",
    "left-arm-slow": "LS",
    "off-spin": "OB",
    "left-arm-orthodox": "SLA",
    "leg-spin": "LB",
    "left-arm-wrist-spin": "SLC",
    "unknown": "",
  };
  return labels[style] || "";
}

/** Short batting hand label */
export function battingHandLabel(hand: string): string {
  return hand === "left" ? "LHB" : "RHB";
}

/** Batting position short label */
export function battingPositionLabel(pos: string): string {
  const labels: Record<string, string> = {
    "opener": "OPN",
    "top-order": "TOP",
    "middle-order": "MID",
    "finisher": "FIN",
    "lower-order": "LOW",
  };
  return labels[pos] || "";
}

/** Batting position color classes */
export function battingPositionColor(pos: string): string {
  switch (pos) {
    case "opener": return "text-sky-400 bg-sky-500/10";
    case "top-order": return "text-blue-400 bg-blue-500/10";
    case "middle-order": return "text-amber-400 bg-amber-500/10";
    case "finisher": return "text-red-400 bg-red-500/10";
    case "lower-order": return "text-gray-400 bg-gray-500/10";
    default: return "text-th-muted";
  }
}

/** Get player photo URL from ESPN CDN. Returns null if no image available. */
export function getPlayerImageUrl(imageUrl?: string): string | null {
  if (!imageUrl || imageUrl.length < 5) return null;
  // ESPN CDN with auto-format and 100px height
  return `https://img1.hscicdn.com/image/upload/f_auto,t_h_100${imageUrl}`;
}

/** Generate a deterministic avatar color from player name (fallback when no photo) */
export function getPlayerAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 50%, 40%)`;
}

/** Get player initials for avatar fallback */
export function getPlayerInitials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
