import { Link } from "react-router-dom";

interface PlayerLinkProps {
  playerId: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps player name text in a Link to /player/:playerId.
 * Inherits text color from parent; adds hover underline.
 */
export function PlayerLink({ playerId, children, className = "" }: PlayerLinkProps) {
  return (
    <Link
      to={`/player/${playerId}`}
      className={`hover:underline decoration-white/30 underline-offset-2 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}
