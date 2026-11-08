/**
 * The live Test in React: the engine's state mutates in place (copying ~1,800 deliveries per ball would be quadratic), so the
 * hook keeps it in a ref and bumps a version on every action; the page re-renders on the version. With a `saveKey` the state
 * is written to IndexedDB after each action (a little later, batched), so the match resumes where it stopped.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TestMatchState } from "@ipl-sim/engine";
import { saveLiveTest } from "./test-db";

export function useLiveTest(initial: TestMatchState, saveKey?: string) {
  const ref = useRef(initial);
  const [version, setVersion] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { ref.current = initial; setVersion(v => v + 1); }, [initial]);

  const persist = useCallback(() => {
    if (!saveKey) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveLiveTest(saveKey, ref.current); }, 400);
  }, [saveKey]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  /** Run an engine action on the state, then re-render and save */
  const act = useCallback(<T,>(fn: (st: TestMatchState) => T): T => {
    const out = fn(ref.current);
    setVersion(v => v + 1);
    persist();
    return out;
  }, [persist]);

  return { st: ref.current, version, act };
}
