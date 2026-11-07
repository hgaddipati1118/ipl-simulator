/**
 * Extended player pool in the app: the CricketArchive players the bundled ESPN pool doesn't have (senior cricket
 * without an ESPN profile, then second XIs, university, club, youth and veterans), about 165k players today and far
 * more later. They are not in the JS bundle: public/pool/manifest.json lists gzip JSON shards (written by
 * packages/ratings/src/pipeline/generate-ca-pool.ts) that are fetched on demand and cached per session.
 *
 * Set VITE_POOL_BASE_URL to serve the shards from elsewhere (object storage / CDN) once they outgrow the repo.
 */

import {
  decodeShard, overallsOf, searchPlayers, topActive,
  type ExtendedPlayer, type PoolGender, type PoolManifest, type PoolShard, type PoolShardInfo,
} from "@ipl-sim/ratings/dist/extended-pool.js";

export type { ExtendedPlayer, PoolGender, PoolManifest, PoolShardInfo };
export { overallsOf };

/** Reads one pool file's bytes (gzip or already decoded) */
export type PoolReader = (file: string) => Promise<Uint8Array>;

const GZIP_MAGIC = [0x1f, 0x8b];

async function toText(bytes: Uint8Array): Promise<string> {
  if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

function fetchReader(): PoolReader {
  const env = (import.meta as unknown as { env?: { VITE_POOL_BASE_URL?: string; BASE_URL?: string } }).env;
  const base = env?.VITE_POOL_BASE_URL ?? `${env?.BASE_URL ?? "/"}pool/`;
  return async file => {
    const res = await fetch(`${base}${file}`);
    if (!res.ok) throw new Error(`Player pool file ${file}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** Which tiers a call covers: "senior" is cricket CricketArchive lists as Twenty20 / List A / First-Class */
export const LOWER_TIERS = ["tier0", "tier1", "tier2", "tier3", "tier4"] as const;

export function createPoolLoader(read: PoolReader = fetchReader()) {
  let manifestPromise: Promise<PoolManifest> | null = null;
  const shards = new Map<string, Promise<ExtendedPlayer[]>>();

  const manifest = () => (manifestPromise ??= read("manifest.json").then(async b => JSON.parse(await toText(b)) as PoolManifest));

  const shard = (info: PoolShardInfo): Promise<ExtendedPlayer[]> => {
    let p = shards.get(info.file);
    if (!p) {
      p = read(info.file).then(async b => decodeShard(JSON.parse(await toText(b)) as PoolShard));
      p.catch(() => shards.delete(info.file)); // retry after a failure
      shards.set(info.file, p);
    }
    return p;
  };

  /** Every player of a gender in the given tiers (default: senior only), loading the shards needed */
  async function players(gender: PoolGender, tiers: readonly string[] = ["senior"]): Promise<ExtendedPlayer[]> {
    const m = await manifest();
    const infos = m.shards.filter(s => s.gender === gender && tiers.includes(s.tier));
    return (await Promise.all(infos.map(shard))).flat();
  }

  /** Counts per gender and tier without loading any player */
  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of (await manifest()).shards) out[`${s.gender}/${s.tier}`] = (out[`${s.gender}/${s.tier}`] ?? 0) + s.count;
    return out;
  }

  /**
   * Extra auction-pool players for a "deep" league: the best `count` active senior players the ESPN pool lacks.
   * Lower-level players never come this way; they are searchable and can be signed from the database search.
   */
  async function auctionExtras(gender: PoolGender, count = 1500): Promise<ExtendedPlayer[]> {
    return topActive(await players(gender, ["senior"]), count);
  }

  async function search(query: string, gender: PoolGender, tiers: readonly string[], limit = 50): Promise<ExtendedPlayer[]> {
    return searchPlayers(await players(gender, tiers), query, limit);
  }

  return { manifest, players, counts, auctionExtras, search };
}

/** The shared loader the app uses */
export const poolLoader = createPoolLoader();
