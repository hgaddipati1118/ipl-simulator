import { type RecruitmentTier } from "../recruitment";

export function RecruitmentBadge({
  tier,
  compact = false,
}: {
  tier: RecruitmentTier | null;
  compact?: boolean;
}) {
  if (!tier) return null;

  const classes = tier === "shortlist"
    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
    : "border-sky-500/30 bg-sky-500/10 text-sky-300";
  const label = compact
    ? tier === "shortlist" ? "SL" : "WL"
    : tier === "shortlist" ? "Shortlist" : "Watchlist";

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-display font-semibold ${classes}`}>
      {label}
    </span>
  );
}

export function RecruitmentActions({
  tier,
  onToggleShortlist,
  onToggleWatchlist,
  compact = false,
}: {
  tier: RecruitmentTier | null;
  onToggleShortlist: () => void;
  onToggleWatchlist: () => void;
  compact?: boolean;
}) {
  const buttonClass = (active: boolean, tone: "shortlist" | "watchlist") => {
    if (tone === "shortlist") {
      return active
        ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
        : "border-th bg-th-raised text-th-secondary hover:text-th-primary hover:bg-th-hover";
    }
    return active
      ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
      : "border-th bg-th-raised text-th-secondary hover:text-th-primary hover:bg-th-hover";
  };

  const sizeClass = compact ? "px-2 py-1 text-[10px]" : "px-3 py-1.5 text-xs";

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onToggleShortlist}
        className={`rounded-lg border font-display font-medium transition-colors ${sizeClass} ${buttonClass(tier === "shortlist", "shortlist")}`}
      >
        {compact ? "SL" : tier === "shortlist" ? "On Shortlist" : "Shortlist"}
      </button>
      <button
        onClick={onToggleWatchlist}
        className={`rounded-lg border font-display font-medium transition-colors ${sizeClass} ${buttonClass(tier === "watchlist", "watchlist")}`}
      >
        {compact ? "WL" : tier === "watchlist" ? "Watching" : "Watchlist"}
      </button>
    </div>
  );
}
