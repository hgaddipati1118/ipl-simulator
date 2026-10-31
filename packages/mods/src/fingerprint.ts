/**
 * Identity of the simulation-affecting mods in play. Saves record it, and
 * multiplayer peers compare it before a match: engine mods change results, so
 * every peer must run exactly the same ones, in the same order.
 */

export interface ModRecord {
  id: string;
  version: string;
  /** SHA-256 of manifest + source. */
  hash: string;
  /** True when the mod has any hook that affects simulation results. */
  engine: boolean;
}

/** Ordered `id@hash` entries of the enabled engine mods. */
export type ModFingerprint = string[];

export function fingerprintOf(records: readonly ModRecord[]): ModFingerprint {
  return records.filter(r => r.engine).map(r => `${r.id}@${r.hash}`);
}

export interface FingerprintComparison {
  ok: boolean;
  /** Human-readable explanation when not ok. */
  reason?: string;
}

const idOf = (entry: string) => entry.slice(0, entry.indexOf("@"));

export function compareFingerprints(a: readonly string[], b: readonly string[], labels: [string, string] = ["you", "the other player"]): FingerprintComparison {
  if (a.length === b.length && a.every((e, i) => e === b[i])) return { ok: true };
  const aIds = new Set(a.map(idOf));
  const bIds = new Set(b.map(idOf));
  const onlyA = [...aIds].filter(id => !bIds.has(id));
  const onlyB = [...bIds].filter(id => !aIds.has(id));
  const differing = [...aIds].filter(id => bIds.has(id) && !b.includes(a.find(e => idOf(e) === id)!));
  const parts: string[] = [];
  if (onlyA.length) parts.push(`only ${labels[0]} have: ${onlyA.join(", ")}`);
  if (onlyB.length) parts.push(`only ${labels[1]} have: ${onlyB.join(", ")}`);
  if (differing.length) parts.push(`different versions of: ${differing.join(", ")}`);
  if (!parts.length) parts.push("same mods in a different order");
  return { ok: false, reason: `Engine mods do not match (${parts.join("; ")})` };
}
