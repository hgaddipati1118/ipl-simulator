/**
 * Player factory: creates players from data or generates random ones.
 * Ported from IndianCricketLeague/createPlayer.js
 */

import { Player, PlayerData, PlayerRatings, PlayerRole } from "./player.js";
import { clamp, randomNormal } from "./math.js";

let playerIdCounter = 0;

export function nextPlayerId(): string {
  return `p_${++playerIdCounter}`;
}

/** Country weights for random generation (approximate representation in T20 cricket) */
const COUNTRY_WEIGHTS: [string, number, boolean][] = [
  // [country, weight, isInternational]
  ["India", 40, false],
  ["Australia", 8, true],
  ["England", 8, true],
  ["South Africa", 6, true],
  ["New Zealand", 5, true],
  ["West Indies", 5, true],
  ["Pakistan", 4, true],
  ["Sri Lanka", 4, true],
  ["Bangladesh", 3, true],
  ["Afghanistan", 3, true],
  ["Zimbabwe", 2, true],
  ["Ireland", 1, true],
  ["Netherlands", 1, true],
  ["Scotland", 1, true],
  ["Nepal", 1, true],
  ["Namibia", 1, true],
  ["USA", 1, true],
  ["UAE", 1, true],
  ["Oman", 1, true],
];

/** First names pool (subset) */
const FIRST_NAMES = [
  "Aarav","Aditya","Ajay","Akash","Amit","Anil","Arjun","Ashwin","Dev","Dhruv",
  "Gaurav","Harsh","Ishaan","Jai","Karan","Krishna","Lakshman","Manish","Naveen","Nikhil",
  "Om","Pranav","Rahul","Ravi","Rohit","Sachin","Sahil","Sanjay","Shreyas","Suresh",
  "Tanmay","Varun","Vikram","Virat","Yash","Ben","Chris","Dan","James","Josh",
  "Kane","Liam","Mark","Nick","Sam","Tom","Will","Aaron","Adam","Alex",
  "David","Glenn","Jake","Kyle","Luke","Matt","Pat","Ryan","Steve","Tim",
  "Hashim","Kagiso","Quinton","Temba","Aiden","Daryl","Devon","Faf","Lungi","Rassie",
  "Andre","Carlos","Dwayne","Jason","Kieron","Nicholas","Shai","Shimron","Sunil","Brandon",
];

const LAST_NAMES = [
  "Sharma","Patel","Kumar","Singh","Verma","Gupta","Chauhan","Yadav","Reddy","Nair",
  "Iyer","Gill","Pandey","Mishra","Joshi","Mehta","Shah","Malhotra","Kapoor","Bhat",
  "Smith","Jones","Brown","Wilson","Taylor","Anderson","Thomas","Jackson","White","Harris",
  "Clark","Lewis","Walker","Hall","Allen","Young","King","Wright","Scott","Green",
  "de Villiers","du Plessis","van der Dussen","Nortje","Rabada","Ngidi","Bavuma","Markram",
  "Pooran","Pollard","Russell","Narine","Holder","Bravo","Hope","Joseph","Hetmyer","Thomas",
  "Williamson","Conway","Ferguson","Boult","Southee","Latham","Mitchell","Nicholls","Phillips","Santner",
  "Starc","Cummins","Warner","Head","Marsh","Maxwell","Zampa","Hazlewood","Lyon","Carey",
];

/** Generate a random player */
export function generateRandomPlayer(overrides?: Partial<PlayerData>): Player {
  // Pick country
  const totalWeight = COUNTRY_WEIGHTS.reduce((s, [,w]) => s + w, 0);
  let r = Math.random() * totalWeight;
  let country = "India";
  let isInternational = false;
  for (const [c, w, intl] of COUNTRY_WEIGHTS) {
    r -= w;
    if (r <= 0) {
      country = c;
      isInternational = intl;
      break;
    }
  }

  // Pick role
  const roleRoll = Math.random();
  let role: PlayerRole;
  if (roleRoll < 0.35) role = "batsman";
  else if (roleRoll < 0.55) role = "bowler";
  else if (roleRoll < 0.85) role = "all-rounder";
  else role = "wicket-keeper";

  // Generate ratings based on role
  const ratings = generateRatings(role);

  const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]
    + " " + LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];

  const age = Math.floor(18 + Math.random() * 20); // 18-37

  return new Player({
    id: nextPlayerId(),
    name,
    age,
    country,
    role,
    ratings,
    isInternational,
    injured: false,
    injuryGamesLeft: 0,
    ...overrides,
  });
}

/** Generate ratings appropriate for a role */
function generateRatings(role: PlayerRole): PlayerRatings {
  const baseRating = () => clamp(Math.round(randomNormal(55, 18)), 15, 95);

  switch (role) {
    case "batsman":
      return {
        battingIQ: clamp(Math.round(randomNormal(70, 14)), 30, 99),
        timing: clamp(Math.round(randomNormal(68, 14)), 30, 99),
        power: clamp(Math.round(randomNormal(60, 16)), 20, 99),
        running: clamp(Math.round(randomNormal(60, 15)), 20, 99),
        wicketTaking: clamp(Math.round(randomNormal(25, 10)), 10, 50),
        economy: clamp(Math.round(randomNormal(25, 10)), 10, 50),
        accuracy: clamp(Math.round(randomNormal(30, 12)), 10, 55),
        clutch: clamp(Math.round(randomNormal(50, 18)), 15, 95),
      };
    case "bowler":
      return {
        battingIQ: clamp(Math.round(randomNormal(30, 12)), 10, 55),
        timing: clamp(Math.round(randomNormal(28, 12)), 10, 50),
        power: clamp(Math.round(randomNormal(25, 12)), 10, 50),
        running: clamp(Math.round(randomNormal(35, 15)), 10, 60),
        wicketTaking: clamp(Math.round(randomNormal(70, 14)), 30, 99),
        economy: clamp(Math.round(randomNormal(68, 14)), 30, 99),
        accuracy: clamp(Math.round(randomNormal(65, 15)), 25, 99),
        clutch: clamp(Math.round(randomNormal(55, 18)), 15, 95),
      };
    case "all-rounder":
      return {
        battingIQ: clamp(Math.round(randomNormal(58, 15)), 25, 95),
        timing: clamp(Math.round(randomNormal(55, 15)), 25, 90),
        power: clamp(Math.round(randomNormal(52, 16)), 20, 90),
        running: clamp(Math.round(randomNormal(55, 14)), 25, 85),
        wicketTaking: clamp(Math.round(randomNormal(55, 15)), 25, 90),
        economy: clamp(Math.round(randomNormal(55, 15)), 25, 90),
        accuracy: clamp(Math.round(randomNormal(50, 15)), 20, 85),
        clutch: clamp(Math.round(randomNormal(55, 18)), 15, 95),
      };
    case "wicket-keeper":
      return {
        battingIQ: clamp(Math.round(randomNormal(65, 14)), 30, 95),
        timing: clamp(Math.round(randomNormal(62, 14)), 28, 95),
        power: clamp(Math.round(randomNormal(55, 16)), 20, 90),
        running: clamp(Math.round(randomNormal(65, 14)), 30, 90),
        wicketTaking: clamp(Math.round(randomNormal(20, 8)), 10, 40),
        economy: clamp(Math.round(randomNormal(20, 8)), 10, 40),
        accuracy: clamp(Math.round(randomNormal(25, 10)), 10, 45),
        clutch: clamp(Math.round(randomNormal(58, 18)), 15, 95),
      };
    default:
      return {
        battingIQ: baseRating(), timing: baseRating(), power: baseRating(),
        running: baseRating(), wicketTaking: baseRating(), economy: baseRating(),
        accuracy: baseRating(), clutch: baseRating(),
      };
  }
}

/** Generate a pool of random players for auction */
export function generatePlayerPool(count: number): Player[] {
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generateRandomPlayer());
  }
  return players;
}

/** Create a player from raw rating data (for importing real players) */
export function createPlayerFromData(data: {
  name: string;
  age: number;
  country: string;
  role?: string;
  battingIQ: number;
  timing: number;
  power: number;
  running: number;
  wicketTaking: number;
  economy: number;
  accuracy: number;
  clutch: number;
  teamId?: string;
  bid?: number;
}): Player {
  const indianCountries = ["India"];
  const isInternational = !indianCountries.includes(data.country);

  let role: PlayerRole;
  if (data.role) {
    role = data.role as PlayerRole;
  } else {
    // Infer from ratings
    const batOvr = data.battingIQ * 0.35 + data.timing * 0.30 + data.power * 0.30 + data.running * 0.05;
    const bowlOvr = data.wicketTaking * 0.40 + data.economy * 0.40 + data.accuracy * 0.10 + data.clutch * 0.10;
    if (batOvr > bowlOvr + 15) role = "batsman";
    else if (bowlOvr > batOvr + 15) role = "bowler";
    else role = "all-rounder";
  }

  return new Player({
    id: nextPlayerId(),
    name: data.name,
    age: data.age,
    country: data.country,
    role,
    ratings: {
      battingIQ: data.battingIQ,
      timing: data.timing,
      power: data.power,
      running: data.running,
      wicketTaking: data.wicketTaking,
      economy: data.economy,
      accuracy: data.accuracy,
      clutch: data.clutch,
    },
    isInternational,
    teamId: data.teamId,
    bid: data.bid,
    injured: false,
    injuryGamesLeft: 0,
  });
}
