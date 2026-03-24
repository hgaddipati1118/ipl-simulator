/**
 * Parse player profile HTML from CricketArchive.
 * Extracts biographical info + career stats from HTML tables.
 */

export interface PlayerBio {
  fullName: string;
  born: string;
  birthDate?: string;    // Parsed date if available
  country: string;
  battingHand: string;
  bowlingStyle: string;
  teams: string[];       // Raw team strings
}

export interface BattingStats {
  matches: number;
  innings: number;
  notOuts: number;
  runs: number;
  highScore: string;     // e.g., "122*"
  average: number;
  hundreds: number;
  fifties: number;
  strikeRate: number;
  catches: number;
  stumpings?: number;
}

export interface BowlingStats {
  balls: number;
  maidens: number;
  runs: number;
  wickets: number;
  bestBowling: string;   // e.g., "4-25"
  average: number;
  fourWickets: number;
  fiveWickets: number;
  strikeRate: number;
  economy: number;
}

export interface PlayerProfile {
  bio: PlayerBio;
  /** T20 career (all T20s combined) */
  t20Batting?: BattingStats;
  t20Bowling?: BowlingStats;
  /** IPL career specifically */
  iplBatting?: BattingStats;
  iplBowling?: BowlingStats;
  /** T20 International career */
  t20iBatting?: BattingStats;
  t20iBowling?: BowlingStats;
  /** Whether this player has T20 data at all */
  hasT20Data: boolean;
  /** Whether the player was active since 2021 (based on date ranges in career sections) */
  activeSince2021: boolean;
}

/** Parse a number, returning 0 for dashes or empty values */
function parseNum(val: string): number {
  if (!val || val === "-" || val === "") return 0;
  return parseFloat(val) || 0;
}

/** Parse an integer */
function parseInt2(val: string): number {
  if (!val || val === "-" || val === "") return 0;
  return parseInt(val, 10) || 0;
}

/**
 * Extract a batting stats row from an HTML table section.
 * Matches the pattern:
 *   <tr><td>TeamName</td><td>M</td><td>I</td>...
 */
function parseBattingTable(html: string, sectionTitle: string): BattingStats | undefined {
  // Find the section
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    escaped + "[^<]*<\\/b><\\/td><\\/tr>\\s*" +
    "<tr><td><\\/td>(?:<td><b>\\w+<\\/b><\\/td>)+<\\/tr>\\s*" +
    "<tr><td>[^<]+<\\/td>((?:<td>[^<]*<\\/td>)+)",
    "i"
  );

  const match = html.match(regex);
  if (!match) return undefined;

  // Extract values from <td> tags
  const values = match[1].match(/<td>([^<]*)<\/td>/g)?.map(v =>
    v.replace(/<\/?td>/g, "").trim()
  );
  if (!values || values.length < 8) return undefined;

  // Check if this table has SRate and Ct columns (T20/ListA/ODI) vs just Ct (Test/FC)
  const hasSRate = values.length >= 10;

  if (hasSRate) {
    // M, I, NO, Runs, HS, Ave, 100, 50, SRate, Ct [, St]
    return {
      matches: parseInt2(values[0]),
      innings: parseInt2(values[1]),
      notOuts: parseInt2(values[2]),
      runs: parseInt2(values[3]),
      highScore: values[4] || "0",
      average: parseNum(values[5]),
      hundreds: parseInt2(values[6]),
      fifties: parseInt2(values[7]),
      strikeRate: parseNum(values[8]),
      catches: parseInt2(values[9]),
      stumpings: values[10] ? parseInt2(values[10]) : undefined,
    };
  } else {
    // M, I, NO, Runs, HS, Ave, 100, 50, Ct [, St]
    return {
      matches: parseInt2(values[0]),
      innings: parseInt2(values[1]),
      notOuts: parseInt2(values[2]),
      runs: parseInt2(values[3]),
      highScore: values[4] || "0",
      average: parseNum(values[5]),
      hundreds: parseInt2(values[6]),
      fifties: parseInt2(values[7]),
      strikeRate: 0,
      catches: parseInt2(values[8]),
      stumpings: values[9] ? parseInt2(values[9]) : undefined,
    };
  }
}

/**
 * Extract a bowling stats row from an HTML table section.
 */
function parseBowlingTable(html: string, sectionTitle: string): BowlingStats | undefined {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    escaped + "[^<]*<\\/b><\\/td><\\/tr>\\s*" +
    "<tr><td><\\/td>(?:<td><b>\\w+<\\/b><\\/td>)+<\\/tr>\\s*" +
    "<tr><td>[^<]+<\\/td>((?:<td>[^<]*<\\/td>)+)",
    "i"
  );

  const match = html.match(regex);
  if (!match) return undefined;

  const values = match[1].match(/<td>([^<]*)<\/td>/g)?.map(v =>
    v.replace(/<\/?td>/g, "").trim()
  );
  if (!values || values.length < 6) return undefined;

  // Balls, Mdns, Runs, Wkts, BBA, Ave, [4wI, 5wI, SRate, Econ] or [5wI, 10wM, SRate, Econ]
  // T20/ODI/ListA bowling: Balls, Mdns, Runs, Wkts, BBA, Ave, 4wI, 5wI, SRate, Econ
  // Test/FC bowling: Balls, Mdns, Runs, Wkts, BBA, Ave, 5wI, 10wM, SRate, Econ

  if (values.length >= 10) {
    return {
      balls: parseInt2(values[0]),
      maidens: parseInt2(values[1]),
      runs: parseInt2(values[2]),
      wickets: parseInt2(values[3]),
      bestBowling: values[4] || "0-0",
      average: parseNum(values[5]),
      fourWickets: parseInt2(values[6]),
      fiveWickets: parseInt2(values[7]),
      strikeRate: parseNum(values[8]),
      economy: parseNum(values[9]),
    };
  } else {
    return {
      balls: parseInt2(values[0]),
      maidens: parseInt2(values[1]),
      runs: parseInt2(values[2]),
      wickets: parseInt2(values[3]),
      bestBowling: values[4] || "0-0",
      average: parseNum(values[5]),
      fourWickets: 0,
      fiveWickets: 0,
      strikeRate: 0,
      economy: 0,
    };
  }
}

/**
 * Check if a career date range overlaps with 2021 or later.
 * Date ranges look like "(2008-2025)" or "(2019/20-2024/25)"
 */
function isActiveSince2021(html: string): boolean {
  // Look for any career section with end year >= 2021
  const yearRanges = html.matchAll(/\((\d{4}(?:\/\d{2})?)\s*-\s*(\d{4}(?:\/\d{2})?)\)/g);
  for (const m of yearRanges) {
    const endYear = parseInt(m[2].substring(0, 4), 10);
    if (endYear >= 2021) return true;
  }
  // Also check single-year ranges like "(2024)"
  const singleYears = html.matchAll(/\((\d{4})\)/g);
  for (const m of singleYears) {
    const year = parseInt(m[1], 10);
    if (year >= 2021) return true;
  }
  return false;
}

/**
 * Parse the biographical section of a player profile page.
 */
function parseBio(html: string): PlayerBio {
  const fullName = html.match(/Full name:([^<]+)/)?.[1]?.trim() ?? "";
  const born = html.match(/Born:([^<]+)/)?.[1]?.trim() ?? "";
  const battingHand = html.match(/Batting:([^<]+)/)?.[1]?.trim() ?? "";
  const bowlingStyle = html.match(/Bowling:([^<]+)/)?.[1]?.trim() ?? "";

  // Extract teams
  const teamsMatch = html.match(/Teams:([^<]+(?:<[^>]+>[^<]+)*)/);
  const teams = teamsMatch?.[1]
    ?.replace(/<[^>]+>/g, "")
    ?.split(";")
    ?.map(t => t.trim())
    ?.filter(Boolean) ?? [];

  // Try to extract country from teams or born field
  const country = born.match(/,\s*([^,]+)$/)?.[1]?.trim() ?? "";

  return { fullName, born, country, battingHand, bowlingStyle, teams };
}

/**
 * Parse a complete CricketArchive player profile HTML page.
 */
export function parsePlayerProfile(html: string): PlayerProfile {
  if (!html || html.includes("<!-- 404 NOT FOUND -->")) {
    return {
      bio: { fullName: "", born: "", country: "", battingHand: "", bowlingStyle: "", teams: [] },
      hasT20Data: false,
      activeSince2021: false,
    };
  }

  const bio = parseBio(html);

  // Parse T20 career stats (all T20s combined)
  const t20Batting = parseBattingTable(html, "Twenty20 Career Batting and Fielding");
  const t20Bowling = parseBowlingTable(html, "Twenty20 Career Bowling");

  // Parse IPL career stats
  const iplBatting = parseBattingTable(html, "Indian Premier League Career Batting and Fielding");
  const iplBowling = parseBowlingTable(html, "Indian Premier League Career Bowling");

  // Parse T20I career stats
  const t20iBatting = parseBattingTable(html, "International Twenty20 Career Batting and Fielding");
  const t20iBowling = parseBowlingTable(html, "International Twenty20 Career Bowling");

  const hasT20Data = !!(t20Batting || t20Bowling || iplBatting || t20iBatting);
  const activeSince2021 = isActiveSince2021(html);

  return {
    bio,
    t20Batting,
    t20Bowling,
    iplBatting,
    iplBowling,
    t20iBatting,
    t20iBowling,
    hasT20Data,
    activeSince2021,
  };
}
