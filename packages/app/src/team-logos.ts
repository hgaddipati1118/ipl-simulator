/**
 * Team logo paths — local PNG files.
 * IPL logos from the official IPL CDN (documents.iplt20.com).
 * WPL shared franchises reuse their IPL logo.
 * GG and UPW logos sourced separately.
 */
const LOGOS: Record<string, string> = {
  // IPL teams
  srh:  "/logos/srh.png",
  dc:   "/logos/dc.png",
  rcb:  "/logos/rcb.png",
  kkr:  "/logos/kkr.png",
  rr:   "/logos/rr.png",
  csk:  "/logos/csk.png",
  mi:   "/logos/mi.png",
  pbks: "/logos/pbks.png",
  gt:   "/logos/gt.png",
  lsg:  "/logos/lsg.png",
  // WPL teams
  "mi-w":  "/logos/mi-w.png",
  "dc-w":  "/logos/dc-w.png",
  "rcb-w": "/logos/rcb-w.png",
  "gg-w":  "/logos/gg-w.png",
  "upw":   "/logos/upw.png",
};

/** Get team logo path. Returns undefined if no logo available. */
export function getTeamLogo(teamId: string): string | undefined {
  return LOGOS[teamId];
}

/** Whether a logo exists for this team */
export function hasLogo(teamId: string): boolean {
  return teamId in LOGOS;
}
