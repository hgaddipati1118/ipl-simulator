/**
 * Saving a live Test so it can be resumed: the engine's state is plain JSON with its random stream inside, so a loaded match
 * carries on exactly where it stopped. Kept in IndexedDB (idb-keyval) under "live-test:<key>": a Test's state is a few
 * hundred KB with its ball-by-ball log, too big for localStorage alongside a save.
 */

import { get, set, del } from "idb-keyval";
import { deserializeTestState, serializeTestState, type TestMatchState } from "@ipl-sim/engine";

const PREFIX = "live-test:";

export async function saveLiveTest(key: string, st: TestMatchState): Promise<void> {
  try {
    await set(PREFIX + key, serializeTestState(st));
  } catch (err) {
    console.warn("[test-db] Failed to save the live Test:", err);
  }
}

export async function loadLiveTest(key: string): Promise<TestMatchState | null> {
  try {
    const json = await get<string>(PREFIX + key);
    return json ? deserializeTestState(json) : null;
  } catch (err) {
    console.warn("[test-db] Failed to load the live Test:", err);
    return null;
  }
}

export async function clearLiveTest(key: string): Promise<void> {
  try {
    await del(PREFIX + key);
  } catch {
    /* nothing saved */
  }
}
