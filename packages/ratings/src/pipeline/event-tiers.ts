/**
 * Tiers of event-only (minor cricket) scorecards, from the event name. Shared by the scraper's ordering
 * (scorecards.ts), the cricket-events.db build (build-db.ts) and the lower-level ratings.
 *   0 senior domestic / touring sides, 1 university, 2 club / league, 3 youth / school, 4 veterans / disability
 */
export const TIER_NAMES = ['senior', 'university', 'club', 'youth', 'veterans'] as const;

/** Scrape order for event-only cards, by event name; anything unmatched is tier 0 (senior) */
const EVENT_TIERS: RegExp[] = [
  /Universit|Cuppers|\bBUCS\b/i,
  /League|Division|\bClub\b|Village|Sunday|Saturday|Evening|Midweek|Inter-District/i,
  /Under-\d+|\bU\d{2}s?\b|School|Grammar|College|Academy|Youth|Junior|Colts|Boys|Girls/i,
  /Over-\d+|Veteran|Legends|Masters|Deaf|Disability|Blind|Visually|Physical|Learning/i,
];

export function eventTier(event = ''): number {
  // Check the most specific tiers first: "Under-15 League" is youth, not club
  for (let t = EVENT_TIERS.length - 1; t >= 0; t--) if (EVENT_TIERS[t].test(event)) return t + 1;
  return 0;
}
