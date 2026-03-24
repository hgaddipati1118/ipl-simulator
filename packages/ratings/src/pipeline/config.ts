/**
 * Configuration for the CricketArchive scraping pipeline.
 */

export const BASE_URL = "https://cricketarchive.com";

/** Delay between HTTP requests in ms (be polite to the server) */
export const REQUEST_DELAY_MS = 1500;

/** Max retries per failed request */
export const MAX_RETRIES = 3;

/** Retry backoff in ms */
export const RETRY_BACKOFF_MS = 10_000;

/** Where to cache raw HTML pages */
export const CACHE_DIR = new URL("../../data/cache", import.meta.url).pathname;

/** Where to store the player index */
export const INDEX_DIR = new URL("../../data/index", import.meta.url).pathname;

/** Where to store scraped stats */
export const OUTPUT_DIR = new URL("../../data/scraped", import.meta.url).pathname;

/**
 * Country codes to crawl on CricketArchive.
 * Focus on countries that produce T20 players active since 2021.
 * Major cricket nations first, then associate/affiliate nations.
 */
export const COUNTRY_CODES: { code: string; name: string }[] = [
  // Full ICC Members (12)
  { code: "IND", name: "India" },
  { code: "AUS", name: "Australia" },
  { code: "ENG", name: "England" },
  { code: "PAK", name: "Pakistan" },
  { code: "RSA", name: "South Africa" },
  { code: "NZ", name: "New Zealand" },
  { code: "SL", name: "Sri Lanka" },
  { code: "WI", name: "West Indies" },
  { code: "BDESH", name: "Bangladesh" },
  { code: "ZIM", name: "Zimbabwe" },
  { code: "AFG", name: "Afghanistan" },
  { code: "IRELAND", name: "Ireland" },
  // Associate nations with active T20 programs
  { code: "CAN", name: "Canada" },
  { code: "DNMRK", name: "Denmark" },
  { code: "GERMANY", name: "Germany" },
  { code: "ITALY", name: "Italy" },
  { code: "NAM", name: "Namibia" },
  { code: "NEPAL", name: "Nepal" },
  { code: "NETH", name: "Netherlands" },
  { code: "OMAN", name: "Oman" },
  { code: "PNG", name: "Papua New Guinea" },
  { code: "SCOT", name: "Scotland" },
  { code: "UAE", name: "United Arab Emirates" },
  { code: "USA", name: "United States of America" },
  { code: "HK", name: "Hong Kong" },
  { code: "KENYA", name: "Kenya" },
  { code: "SING", name: "Singapore" },
  { code: "UGA", name: "Uganda" },
  { code: "JERSEY", name: "Jersey" },
  { code: "GUERNSEY", name: "Guernsey" },
  { code: "MALAYSIA", name: "Malaysia" },
  { code: "THAI", name: "Thailand" },
  { code: "BERMUDA", name: "Bermuda" },
  { code: "BMDA", name: "Bermuda" },
  { code: "CYP", name: "Cyprus" },
  { code: "AUSTRIA", name: "Austria" },
  { code: "BELGIUM", name: "Belgium" },
  { code: "FRANCE", name: "France" },
  { code: "CZK", name: "Czech Republic" },
  { code: "ROMANIA", name: "Romania" },
  { code: "HUNGARY", name: "Hungary" },
  { code: "SPAIN", name: "Spain" },
  { code: "PORTUGAL", name: "Portugal" },
  { code: "SWEDEN", name: "Sweden" },
  { code: "FINLAND", name: "Finland" },
  { code: "NORWAY", name: "Norway" },
  { code: "EST", name: "Estonia" },
  { code: "BULG", name: "Bulgaria" },
  { code: "CRT", name: "Croatia" },
  { code: "TANZANIA", name: "Tanzania" },
  { code: "BOT", name: "Botswana" },
  { code: "MALAWI", name: "Malawi" },
  { code: "GHANA", name: "Ghana" },
  { code: "CAM", name: "Cameroon" },
  { code: "NIGERIA", name: "Nigeria" },
  { code: "RWANDA", name: "Rwanda" },
  { code: "MOZ", name: "Mozambique" },
  { code: "SWAZ", name: "Eswatini" },
  { code: "LESOTHO", name: "Lesotho" },
  { code: "SIERRA", name: "Sierra Leone" },
  { code: "FIJI", name: "Fiji" },
  { code: "SAMOA", name: "Samoa" },
  { code: "VANUATU", name: "Vanuatu" },
  { code: "COOKI", name: "Cook Islands" },
  { code: "ARG", name: "Argentina" },
  { code: "BRAZIL", name: "Brazil" },
  { code: "CHILE", name: "Chile" },
  { code: "MEXICO", name: "Mexico" },
  { code: "PANAMA", name: "Panama" },
  { code: "BAHRAIN", name: "Bahrain" },
  { code: "KUWAIT", name: "Kuwait" },
  { code: "QATAR", name: "Qatar" },
  { code: "SAUDI", name: "Saudi Arabia" },
  { code: "IRAN", name: "Iran" },
  { code: "BAH", name: "Bahrain" },
  { code: "BHU", name: "Bhutan" },
  { code: "MALDIVES", name: "Maldives" },
  { code: "MYANMAR", name: "Myanmar" },
  { code: "CAY", name: "Cayman Islands" },
  { code: "BLZ", name: "Belize" },
];

/**
 * URL templates for per-player detailed stats pages.
 * Pattern: /Archive/Players/{bucket}/{id}/{page}
 */
export const PLAYER_SUBPAGES = [
  "{id}.html",                               // Career profile
  "statistics_lists.html",                   // Index of all detailed views
  "Twenty20_Matches.html",                   // T20 match-by-match
  "Indian_Premier_League_Matches.html",      // IPL match-by-match
  "tt_Batting_by_Season.html",               // T20 batting by season
  "tt_Bowling_by_Season.html",               // T20 bowling by season
  "ipl_Batting_by_Season.html",              // IPL batting by season
  "ipl_Bowling_by_Season.html",              // IPL bowling by season
] as const;
