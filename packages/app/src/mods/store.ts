/**
 * IndexedDB persistence for installed mods (the `mods` store). One record per mod
 * plus an `order` list, because hooks compose in install order.
 */

import { get, set, del, createStore } from "idb-keyval";
import type { ModManifest } from "@ipl-sim/mods";

// Opened on first use so importing this module never touches IndexedDB (tests, SSR)
let opened: ReturnType<typeof createStore> | null = null;
const modStore = () => (opened ??= createStore("ipl-sim-mods", "mods"));
const ORDER_KEY = "__order";

export interface StoredMod {
  manifest: ModManifest;
  source: string;
  hash: string;
  enabled: boolean;
  strikes: number;
  disabledReason?: string;
  installedAt: number;
}

export async function listStoredMods(): Promise<StoredMod[]> {
  const order = (await get<string[]>(ORDER_KEY, modStore())) ?? [];
  const mods = await Promise.all(order.map(id => get<StoredMod>(id, modStore())));
  return mods.filter((m): m is StoredMod => !!m);
}

export async function putStoredMod(mod: StoredMod): Promise<void> {
  const order = (await get<string[]>(ORDER_KEY, modStore())) ?? [];
  if (!order.includes(mod.manifest.id)) await set(ORDER_KEY, [...order, mod.manifest.id], modStore());
  await set(mod.manifest.id, mod, modStore());
}

export async function deleteStoredMod(id: string): Promise<void> {
  const order = (await get<string[]>(ORDER_KEY, modStore())) ?? [];
  await set(ORDER_KEY, order.filter(x => x !== id), modStore());
  await del(id, modStore());
}
