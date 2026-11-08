import type { Player } from "@ipl-sim/engine";
import { RATING_FORMATS, type RatingFormat } from "../format-ratings";

/** T20 / ODI / Test segmented switch for rating views */
export function FormatSwitch({ value, onChange, className = "" }: { value: RatingFormat; onChange: (f: RatingFormat) => void; className?: string }) {
  return (
    <div role="group" aria-label="Ratings format" className={`flex w-full rounded-xl border border-th bg-th-surface p-0.5 sm:w-auto ${className}`}>
      {RATING_FORMATS.map(f => (
        <button
          key={f.id}
          type="button"
          onClick={() => onChange(f.id)}
          aria-pressed={value === f.id}
          className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-display font-medium transition-colors sm:flex-none ${
            value === f.id ? "bg-orange-500/15 text-orange-300" : "text-th-muted hover:text-th-primary"
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** How a player's rating in `format` was made: nothing for T20 or measured sets, a mark for derived or missing ones */
export function FormatSourceMark({ player, format }: { player: Player; format: RatingFormat }) {
  if (format === "t20") return null;
  const fr = player.formatRatings?.[format];
  const label = format === "odi" ? "ODI" : "Test";
  if (!fr) {
    return <span className="block text-[9px] text-th-faint font-display" title={`No ${label} ratings: plays ${label}s on his T20 ratings`}>T20</span>;
  }
  if (fr.source === "derived") {
    return <span className="block text-[9px] text-th-faint font-display" title={`Derived: too little ${label} (${format === "odi" ? "List A" : "first-class"}) cricket, translated from his other formats`}>est.</span>;
  }
  return null;
}
