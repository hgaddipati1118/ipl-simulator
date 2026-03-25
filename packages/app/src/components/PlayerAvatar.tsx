import { useState } from "react";
import { getPlayerImageUrl, getPlayerInitials, getPlayerAvatarColor } from "../ui-utils";

interface PlayerAvatarProps {
  name: string;
  imageUrl?: string;
  size?: "sm" | "md" | "lg";
  teamColor?: string;
}

const SIZE_CLASSES = {
  sm: { container: "w-8 h-8", text: "text-[10px]" },
  md: { container: "w-12 h-12", text: "text-sm" },
  lg: { container: "w-16 h-16", text: "text-lg" },
};

export function PlayerAvatar({ name, imageUrl, size = "md", teamColor }: PlayerAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const fullUrl = getPlayerImageUrl(imageUrl);
  const s = SIZE_CLASSES[size];

  if (fullUrl && !imgError) {
    return (
      <img
        src={fullUrl}
        alt={name}
        loading="lazy"
        onError={() => setImgError(true)}
        className={`${s.container} rounded-full object-cover flex-shrink-0`}
      />
    );
  }

  const bgColor = teamColor ?? getPlayerAvatarColor(name);
  const initials = getPlayerInitials(name);

  return (
    <div
      className={`${s.container} rounded-full flex-shrink-0 flex items-center justify-center font-display font-bold text-white ${s.text}`}
      style={{ backgroundColor: bgColor }}
      aria-label={name}
    >
      {initials}
    </div>
  );
}
