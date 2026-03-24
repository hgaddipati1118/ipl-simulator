import { badgeTextColor, badgeBorderStyle } from "../ui-utils";
import { getTeamLogo } from "../team-logos";

interface TeamBadgeProps {
  teamId: string;
  shortName: string;
  primaryColor: string;
  /** Size variant */
  size?: "sm" | "md" | "lg";
}

const SIZES = {
  sm: { img: "w-7 h-7", badge: "w-7 h-7 rounded-lg text-[10px]" },
  md: { img: "w-12 h-12", badge: "w-12 h-12 rounded-xl text-xs" },
  lg: { img: "w-16 h-16", badge: "w-14 h-14 rounded-2xl text-base" },
};

export function TeamBadge({ teamId, shortName, primaryColor, size = "md" }: TeamBadgeProps) {
  const logo = getTeamLogo(teamId);
  const s = SIZES[size];

  if (logo) {
    return <img src={logo} alt={shortName} className={`${s.img} object-contain drop-shadow-lg`} />;
  }

  return (
    <div
      className={`${s.badge} flex-shrink-0 flex items-center justify-center font-display font-bold shadow-lg`}
      style={{
        backgroundColor: primaryColor,
        color: badgeTextColor(primaryColor),
        boxShadow: `0 4px 20px ${primaryColor}40`,
        border: badgeBorderStyle(primaryColor),
      }}
    >
      {size === "sm" ? shortName.slice(0, 2) : shortName}
    </div>
  );
}
