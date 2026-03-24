/**
 * IndexedDB storage for ball-by-ball match detail data.
 *
 * Keeps heavy DetailedMatchResult objects out of localStorage.
 * Uses native IndexedDB API (no libraries) for broad compatibility.
 *
 * Database: "ipl-simulator-matches"
 * Object stores:
 *   "matches" — keyed by `${seasonNumber}-${matchIndex}`, stores DetailedMatchResult
 *   "seasons" — keyed by seasonNumber, stores season-level metadata
 */

import type { DetailedMatchResult } from "@ipl-sim/engine";

const DB_NAME = "ipl-simulator-matches";
const DB_VERSION = 2;
const MATCHES_STORE = "matches";
const SEASONS_STORE = "seasons";
const IN_PROGRESS_STORE = "in_progress_matches";

// ── Cached DB connection ─────────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function matchKey(seasonNumber: number, matchIndex: number): string {
  return `${seasonNumber}-${matchIndex}`;
}

/** Open (or return cached) IndexedDB connection */
export function initMatchDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion;

        // Version 1: matches + seasons stores
        if (oldVersion < 1) {
          // Matches store: keyed by "seasonNumber-matchIndex"
          if (!db.objectStoreNames.contains(MATCHES_STORE)) {
            const store = db.createObjectStore(MATCHES_STORE);
            // Index for fetching all matches in a season
            store.createIndex("bySeason", "seasonNumber", { unique: false });
          }

          // Seasons metadata store
          if (!db.objectStoreNames.contains(SEASONS_STORE)) {
            db.createObjectStore(SEASONS_STORE);
          }
        }

        // Version 2: in-progress match store for live match save/resume
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(IN_PROGRESS_STORE)) {
            db.createObjectStore(IN_PROGRESS_STORE);
          }
        }
      };

      request.onsuccess = () => {
        dbInstance = request.result;

        // Handle unexpected close (e.g. version change in another tab)
        dbInstance.onclose = () => {
          dbInstance = null;
          dbPromise = null;
        };

        resolve(dbInstance);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };

      request.onblocked = () => {
        dbPromise = null;
        reject(new Error("IndexedDB blocked — close other tabs"));
      };
    } catch (err) {
      dbPromise = null;
      reject(err);
    }
  });

  return dbPromise;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Wrap an IDBRequest in a Promise */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Safely get a DB connection, returning null if IndexedDB is unavailable */
async function getDB(): Promise<IDBDatabase | null> {
  try {
    return await initMatchDB();
  } catch (err) {
    console.warn("[match-db] IndexedDB unavailable:", err);
    return null;
  }
}

// ── Stored record shape ──────────────────────────────────────────────────

interface MatchRecord {
  seasonNumber: number;
  matchIndex: number;
  detail: DetailedMatchResult;
}

// ── Core API ─────────────────────────────────────────────────────────────

/**
 * Save a DetailedMatchResult to IndexedDB.
 */
export async function saveMatchDetail(
  seasonNumber: number,
  matchIndex: number,
  detail: DetailedMatchResult,
): Promise<boolean> {
  const db = await getDB();
  if (!db) return false;

  try {
    const tx = db.transaction(MATCHES_STORE, "readwrite");
    const store = tx.objectStore(MATCHES_STORE);
    const record: MatchRecord = { seasonNumber, matchIndex, detail };
    store.put(record, matchKey(seasonNumber, matchIndex));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn("[match-db] Failed to save match detail:", err);
    return false;
  }
}

/**
 * Retrieve a single match's DetailedMatchResult.
 * Returns null if not found or IndexedDB unavailable.
 */
export async function getMatchDetail(
  seasonNumber: number,
  matchIndex: number,
): Promise<DetailedMatchResult | null> {
  const db = await getDB();
  if (!db) return null;

  try {
    const tx = db.transaction(MATCHES_STORE, "readonly");
    const store = tx.objectStore(MATCHES_STORE);
    const record = await requestToPromise<MatchRecord | undefined>(
      store.get(matchKey(seasonNumber, matchIndex)),
    );
    return record?.detail ?? null;
  } catch (err) {
    console.warn("[match-db] Failed to get match detail:", err);
    return null;
  }
}

/**
 * Retrieve all match details for a given season.
 */
export async function getAllSeasonMatches(
  seasonNumber: number,
): Promise<DetailedMatchResult[]> {
  const db = await getDB();
  if (!db) return [];

  try {
    const tx = db.transaction(MATCHES_STORE, "readonly");
    const store = tx.objectStore(MATCHES_STORE);
    const index = store.index("bySeason");
    const records = await requestToPromise<MatchRecord[]>(
      index.getAll(seasonNumber),
    );
    return records
      .sort((a, b) => a.matchIndex - b.matchIndex)
      .map(r => r.detail);
  } catch (err) {
    console.warn("[match-db] Failed to get season matches:", err);
    return [];
  }
}

/**
 * Search a season's matches for a specific player's appearances.
 * Returns matches where the player batted or bowled (checked via scorecards).
 */
export async function getPlayerMatchHistory(
  playerId: string,
  seasonNumber: number,
): Promise<{ matchIndex: number; detail: DetailedMatchResult }[]> {
  const db = await getDB();
  if (!db) return [];

  try {
    const tx = db.transaction(MATCHES_STORE, "readonly");
    const store = tx.objectStore(MATCHES_STORE);
    const index = store.index("bySeason");
    const records = await requestToPromise<MatchRecord[]>(
      index.getAll(seasonNumber),
    );

    return records
      .filter(r => {
        const d = r.detail;
        // Check if player appears in either innings scorecard
        const inInnings1 = d.innings1.batters.some(b => b.playerId === playerId) ||
                           d.innings1.bowlers.some(b => b.playerId === playerId);
        const inInnings2 = d.innings2.batters.some(b => b.playerId === playerId) ||
                           d.innings2.bowlers.some(b => b.playerId === playerId);
        return inInnings1 || inInnings2;
      })
      .sort((a, b) => a.matchIndex - b.matchIndex)
      .map(r => ({ matchIndex: r.matchIndex, detail: r.detail }));
  } catch (err) {
    console.warn("[match-db] Failed to get player history:", err);
    return [];
  }
}

/**
 * Delete all match data for a given season.
 */
export async function deleteSeasonMatches(
  seasonNumber: number,
): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    const tx = db.transaction(MATCHES_STORE, "readwrite");
    const store = tx.objectStore(MATCHES_STORE);
    const index = store.index("bySeason");

    // Get all keys for this season, then delete them
    const request = index.openKeyCursor(seasonNumber);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });

    // Also remove season metadata
    const metaTx = db.transaction(SEASONS_STORE, "readwrite");
    metaTx.objectStore(SEASONS_STORE).delete(seasonNumber);
    await new Promise<void>((resolve, reject) => {
      metaTx.oncomplete = () => resolve();
      metaTx.onerror = () => reject(metaTx.error);
    });
  } catch (err) {
    console.warn("[match-db] Failed to delete season matches:", err);
  }
}

/**
 * Clear all match data across all seasons.
 */
export async function clearAllMatchData(): Promise<boolean> {
  const db = await getDB();
  if (!db) return false;

  try {
    const tx = db.transaction([MATCHES_STORE, SEASONS_STORE, IN_PROGRESS_STORE], "readwrite");
    tx.objectStore(MATCHES_STORE).clear();
    tx.objectStore(SEASONS_STORE).clear();
    tx.objectStore(IN_PROGRESS_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn("[match-db] Failed to clear all match data:", err);
    return false;
  }
}

// ── In-progress match store (for live match save/resume) ────────────────

interface InProgressRecord {
  seasonNumber: number;
  matchIndex: number;
  matchState: unknown; // serialized MatchState
  savedAt: number;     // timestamp
}

function inProgressKey(seasonNumber: number, matchIndex: number): string {
  return `${seasonNumber}-${matchIndex}`;
}

/**
 * Save an in-progress match state to IndexedDB.
 * Called after every over during live match viewing.
 */
export async function saveInProgressMatch(
  seasonNumber: number,
  matchIndex: number,
  matchState: unknown,
): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    const tx = db.transaction(IN_PROGRESS_STORE, "readwrite");
    const store = tx.objectStore(IN_PROGRESS_STORE);
    const record: InProgressRecord = {
      seasonNumber,
      matchIndex,
      matchState,
      savedAt: Date.now(),
    };
    store.put(record, inProgressKey(seasonNumber, matchIndex));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[match-db] Failed to save in-progress match:", err);
  }
}

/**
 * Retrieve an in-progress match state.
 */
export async function getInProgressMatch(
  seasonNumber: number,
  matchIndex: number,
): Promise<unknown | null> {
  const db = await getDB();
  if (!db) return null;

  try {
    const tx = db.transaction(IN_PROGRESS_STORE, "readonly");
    const store = tx.objectStore(IN_PROGRESS_STORE);
    const record = await requestToPromise<InProgressRecord | undefined>(
      store.get(inProgressKey(seasonNumber, matchIndex)),
    );
    return record?.matchState ?? null;
  } catch (err) {
    console.warn("[match-db] Failed to get in-progress match:", err);
    return null;
  }
}

/**
 * Clear a specific in-progress match (called when match completes).
 */
export async function clearInProgressMatch(
  seasonNumber: number,
  matchIndex: number,
): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    const tx = db.transaction(IN_PROGRESS_STORE, "readwrite");
    const store = tx.objectStore(IN_PROGRESS_STORE);
    store.delete(inProgressKey(seasonNumber, matchIndex));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[match-db] Failed to clear in-progress match:", err);
  }
}

/**
 * Check if there is any in-progress match for a given season.
 * Returns the match index if found, null otherwise.
 */
export async function hasInProgressMatch(
  seasonNumber: number,
): Promise<{ matchIndex: number } | null> {
  const db = await getDB();
  if (!db) return null;

  try {
    const tx = db.transaction(IN_PROGRESS_STORE, "readonly");
    const store = tx.objectStore(IN_PROGRESS_STORE);
    const allKeys = await requestToPromise<IDBValidKey[]>(store.getAllKeys());

    const prefix = `${seasonNumber}-`;
    for (const key of allKeys) {
      const keyStr = String(key);
      if (keyStr.startsWith(prefix)) {
        const matchIndex = parseInt(keyStr.slice(prefix.length), 10);
        if (!isNaN(matchIndex)) {
          return { matchIndex };
        }
      }
    }
    return null;
  } catch (err) {
    console.warn("[match-db] Failed to check in-progress matches:", err);
    return null;
  }
}
