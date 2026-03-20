/**
 * Real IPL player data with hand-tuned ratings.
 * Based on IndianCricketLeague/playerRatings.js and updated for 2025 IPL.
 *
 * Format: [name, age, country, role, batIQ, timing, power, running, wktTaking, econ, accuracy, clutch, teamId]
 */

type PlayerTuple = [string, number, string, string, number, number, number, number, number, number, number, number, string];

export const REAL_PLAYERS: PlayerTuple[] = [
  // --- Sunrisers Hyderabad (SRH) ---
  ["Travis Head",       30, "Australia",     "batsman",       82, 85, 88, 72, 22, 20, 28, 45, "srh"],
  ["Heinrich Klaasen",  33, "South Africa",  "wicket-keeper", 80, 82, 92, 65, 18, 15, 20, 78, "srh"],
  ["Pat Cummins",       31, "Australia",     "bowler",        45, 48, 35, 40, 85, 82, 80, 82, "srh"],
  ["Abhishek Sharma",   24, "India",         "all-rounder",   68, 65, 78, 60, 42, 38, 35, 55, "srh"],
  ["Nitish Kumar Reddy",21, "India",         "all-rounder",   62, 60, 68, 55, 55, 52, 50, 58, "srh"],

  // --- Delhi Capitals (DC) ---
  ["KL Rahul",          32, "India",         "wicket-keeper", 88, 90, 72, 68, 15, 12, 18, 72, "dc"],
  ["Jake Fraser-McGurk",22, "Australia",     "batsman",       65, 62, 88, 58, 15, 12, 15, 50, "dc"],
  ["Axar Patel",        30, "India",         "all-rounder",   60, 58, 62, 55, 72, 75, 70, 68, "dc"],
  ["Mitchell Starc",    34, "Australia",     "bowler",        30, 28, 35, 25, 88, 78, 82, 80, "dc"],
  ["Kuldeep Yadav",     30, "India",         "bowler",        25, 22, 18, 30, 82, 80, 78, 75, "dc"],

  // --- Royal Challengers Bengaluru (RCB) ---
  ["Virat Kohli",       36, "India",         "batsman",       95, 95, 82, 80, 12, 10, 15, 92, "rcb"],
  ["Rajat Patidar",     31, "India",         "batsman",       72, 75, 78, 62, 15, 12, 18, 60, "rcb"],
  ["Phil Salt",         28, "England",       "wicket-keeper", 72, 70, 85, 68, 10, 8,  12, 58, "rcb"],
  ["Josh Hazlewood",    34, "Australia",     "bowler",        20, 18, 15, 22, 82, 88, 85, 78, "rcb"],
  ["Bhuvneshwar Kumar", 34, "India",         "bowler",        30, 28, 22, 35, 78, 82, 85, 72, "rcb"],

  // --- Kolkata Knight Riders (KKR) ---
  ["Sunil Narine",      36, "West Indies",   "all-rounder",   72, 68, 82, 45, 80, 82, 78, 85, "kkr"],
  ["Andre Russell",     36, "West Indies",   "all-rounder",   65, 60, 95, 50, 65, 55, 52, 78, "kkr"],
  ["Rinku Singh",       27, "India",         "batsman",       72, 75, 80, 65, 12, 10, 15, 88, "kkr"],
  ["Varun Chakaravarthy",33,"India",         "bowler",        15, 12, 10, 20, 82, 85, 80, 72, "kkr"],
  ["Venkatesh Iyer",    29, "India",         "all-rounder",   68, 65, 72, 58, 45, 42, 40, 55, "kkr"],

  // --- Rajasthan Royals (RR) ---
  ["Sanju Samson",      30, "India",         "wicket-keeper", 78, 82, 85, 65, 10, 8,  12, 72, "rr"],
  ["Yashasvi Jaiswal",  23, "India",         "batsman",       82, 85, 80, 72, 18, 15, 20, 68, "rr"],
  ["Jos Buttler",       34, "England",       "wicket-keeper", 85, 88, 90, 70, 10, 8,  10, 80, "rr"],
  ["Yuzvendra Chahal",  34, "India",         "bowler",        15, 12, 10, 18, 88, 78, 75, 80, "rr"],
  ["Trent Boult",       35, "New Zealand",   "bowler",        22, 20, 18, 25, 82, 80, 82, 75, "rr"],

  // --- Chennai Super Kings (CSK) ---
  ["Ruturaj Gaikwad",   27, "India",         "batsman",       82, 85, 72, 70, 12, 10, 15, 68, "csk"],
  ["Ravindra Jadeja",   36, "India",         "all-rounder",   65, 62, 68, 72, 72, 78, 75, 80, "csk"],
  ["Devon Conway",      33, "New Zealand",   "batsman",       78, 82, 70, 68, 10, 8,  12, 62, "csk"],
  ["Matheesha Pathirana",22,"Sri Lanka",     "bowler",        15, 12, 10, 20, 80, 75, 72, 70, "csk"],
  ["Rachin Ravindra",   25, "New Zealand",   "all-rounder",   72, 70, 65, 62, 55, 58, 55, 55, "csk"],

  // --- Mumbai Indians (MI) ---
  ["Rohit Sharma",      37, "India",         "batsman",       90, 92, 85, 65, 12, 10, 15, 82, "mi"],
  ["Suryakumar Yadav",  34, "India",         "batsman",       85, 90, 88, 72, 10, 8,  12, 78, "mi"],
  ["Jasprit Bumrah",    31, "India",         "bowler",        18, 15, 12, 22, 95, 92, 90, 90, "mi"],
  ["Hardik Pandya",     31, "India",         "all-rounder",   75, 72, 88, 60, 70, 68, 65, 75, "mi"],
  ["Tilak Varma",       22, "India",         "batsman",       72, 75, 70, 65, 18, 15, 20, 62, "mi"],

  // --- Punjab Kings (PBKS) ---
  ["Shikhar Dhawan",    38, "India",         "batsman",       82, 85, 72, 55, 10, 8,  12, 65, "pbks"],
  ["Shreyas Iyer",      30, "India",         "batsman",       80, 82, 75, 65, 12, 10, 15, 72, "pbks"],
  ["Arshdeep Singh",    25, "India",         "bowler",        18, 15, 12, 22, 80, 78, 75, 72, "pbks"],
  ["Kagiso Rabada",     29, "South Africa",  "bowler",        25, 22, 20, 28, 88, 82, 80, 82, "pbks"],
  ["Liam Livingstone",  31, "England",       "all-rounder",   65, 62, 90, 55, 48, 45, 42, 60, "pbks"],

  // --- Gujarat Titans (GT) ---
  ["Shubman Gill",      25, "India",         "batsman",       85, 88, 78, 72, 12, 10, 15, 70, "gt"],
  ["Rashid Khan",       26, "Afghanistan",   "all-rounder",   55, 52, 62, 48, 92, 88, 85, 88, "gt"],
  ["Mohammed Shami",    34, "India",         "bowler",        20, 18, 15, 22, 88, 82, 85, 78, "gt"],
  ["David Miller",      35, "South Africa",  "batsman",       72, 75, 88, 60, 10, 8,  12, 82, "gt"],
  ["Sai Sudharsan",     22, "India",         "batsman",       72, 75, 68, 65, 10, 8,  12, 55, "gt"],

  // --- Lucknow Super Giants (LSG) ---
  ["Nicholas Pooran",   28, "West Indies",   "wicket-keeper", 72, 70, 92, 60, 10, 8,  12, 68, "lsg"],
  ["Marcus Stoinis",    35, "Australia",     "all-rounder",   68, 65, 82, 58, 55, 52, 50, 65, "lsg"],
  ["Ravi Bishnoi",      24, "India",         "bowler",        15, 12, 10, 22, 78, 80, 75, 68, "lsg"],
  ["Avesh Khan",        27, "India",         "bowler",        18, 15, 12, 22, 72, 68, 65, 62, "lsg"],
  ["Quinton de Kock",   32, "South Africa",  "wicket-keeper", 82, 80, 85, 65, 10, 8,  12, 72, "lsg"],
];

export interface RealPlayerData {
  name: string;
  age: number;
  country: string;
  role: string;
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  teamId: string;
}

export function getRealPlayers(): RealPlayerData[] {
  return REAL_PLAYERS.map(([name, age, country, role, batIQ, timing, power, running, wkt, econ, acc, clutch, teamId]) => ({
    name, age, country, role,
    battingIQ: batIQ, timing, power, running,
    wicketTaking: wkt, economy: econ, accuracy: acc, clutch,
    teamId,
  }));
}
