/**
 * Saving a live Test so it can be resumed: the engine's state is plain JSON with its random stream inside, so a loaded match
 * carries on exactly where it stopped. Kept in IndexedDB (idb-keyval) under "live-test:<key>": a Test's state is a few
 * hundred KB with its ball-by-ball log, too big for localStorage alongside a save.
 */

import { get, set, del, delMany, keys } from "idb-keyval";
import { deserializeTestState, serializeTestState, type TestMatchState } from "@ipl-sim/engine";

const PREFIX = "live-test:";

/** No IndexedDB (server render, unit tests): nothing is saved */
const available = () => typeof indexedDB !== "undefined";

export async function saveLiveTest(key: string, st: TestMatchState): Promise<void> {
  if (!available()) return;
  try {
    await set(PREFIX + key, serializeTestState(st));
  } catch (err) {
    console.warn("[test-db] Failed to save the live Test:", err);
  }
}

export async function loadLiveTest(key: string): Promise<TestMatchState | null> {
  if (!available()) return null;
  try {
    const json = await get<string>(PREFIX + key);
    return json ? deserializeTestState(json) : null;
  } catch (err) {
    console.warn("[test-db] Failed to load the live Test:", err);
    return null;
  }
}

export async function clearLiveTest(key: string): Promise<void> {
  if (!available()) return;
  try {
    await del(PREFIX + key);
  } catch {
    /* nothing saved */
  }
}

/** Delete every saved Test whose key starts with `prefix` (a new International series clears the last one's Tests) */
export async function clearLiveTests(prefix: string): Promise<void> {
  if (!available()) return;
  try {
    const all = await keys();
    await delMany(all.filter(k => typeof k === "string" && k.startsWith(PREFIX + prefix)));
  } catch {
    /* nothing saved */
  }
}
