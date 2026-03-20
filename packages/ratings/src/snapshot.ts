/**
 * Rating snapshot system.
 *
 * Captures player ratings at specific timestamps (e.g. after each season,
 * mid-season, or at any arbitrary point) so you can track how players
 * evolve over time.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = path.join(__dirname, "..", "data", "snapshots");

export interface PlayerRatingSnapshot {
  id: string;
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
  battingOvr: number;
  bowlingOvr: number;
  overall: number;
  // Season stats at time of snapshot
  seasonRuns?: number;
  seasonWickets?: number;
  seasonMatches?: number;
}

export interface RatingSnapshot {
  timestamp: string;       // ISO date string
  label: string;           // e.g. "IPL 2024 - Post Auction", "IPL 2024 - Mid Season"
  seasonNumber?: number;
  players: PlayerRatingSnapshot[];
}

/**
 * Save a snapshot to disk.
 */
export function saveSnapshot(snapshot: RatingSnapshot): string {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  const filename = `${snapshot.timestamp.replace(/[:.]/g, "-")}_${snapshot.label.replace(/\s+/g, "_").toLowerCase()}.json`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  return filepath;
}

/**
 * Load all snapshots from disk, sorted by timestamp.
 */
export function loadAllSnapshots(): RatingSnapshot[] {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];

  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();

  return files.map(f => {
    const content = fs.readFileSync(path.join(SNAPSHOTS_DIR, f), "utf-8");
    return JSON.parse(content) as RatingSnapshot;
  });
}

/**
 * Load a specific snapshot by label or timestamp prefix.
 */
export function loadSnapshot(query: string): RatingSnapshot | null {
  const all = loadAllSnapshots();
  return all.find(s =>
    s.label.toLowerCase().includes(query.toLowerCase()) ||
    s.timestamp.startsWith(query)
  ) ?? null;
}

/**
 * Get a player's rating history across all snapshots.
 */
export function getPlayerHistory(playerId: string): {
  timestamps: string[];
  labels: string[];
  ratings: PlayerRatingSnapshot[];
} {
  const snapshots = loadAllSnapshots();
  const timestamps: string[] = [];
  const labels: string[] = [];
  const ratings: PlayerRatingSnapshot[] = [];

  for (const snap of snapshots) {
    const player = snap.players.find(p => p.id === playerId);
    if (player) {
      timestamps.push(snap.timestamp);
      labels.push(snap.label);
      ratings.push(player);
    }
  }

  return { timestamps, labels, ratings };
}

/**
 * Compare two snapshots: show rating changes for each player.
 */
export function compareSnapshots(
  before: RatingSnapshot,
  after: RatingSnapshot,
): {
  playerId: string;
  name: string;
  overallBefore: number;
  overallAfter: number;
  change: number;
}[] {
  const changes: { playerId: string; name: string; overallBefore: number; overallAfter: number; change: number }[] = [];

  const beforeMap = new Map(before.players.map(p => [p.id, p]));

  for (const afterPlayer of after.players) {
    const beforePlayer = beforeMap.get(afterPlayer.id);
    if (beforePlayer) {
      changes.push({
        playerId: afterPlayer.id,
        name: afterPlayer.name,
        overallBefore: beforePlayer.overall,
        overallAfter: afterPlayer.overall,
        change: afterPlayer.overall - beforePlayer.overall,
      });
    }
  }

  return changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

// CLI: take a snapshot from current state
if (process.argv[1] && process.argv[1].includes("snapshot")) {
  const label = process.argv[2] || `Snapshot ${new Date().toISOString().split("T")[0]}`;
  console.log(`Creating snapshot: "${label}"`);
  console.log("Use this module programmatically to pass player data.");
  console.log("Example: saveSnapshot({ timestamp: new Date().toISOString(), label, players: [...] })");
}
