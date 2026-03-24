/**
 * Rate-limited HTTP fetcher with local file caching.
 * Respects CricketArchive's server by spacing requests.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { CACHE_DIR, REQUEST_DELAY_MS, MAX_RETRIES, RETRY_BACKOFF_MS } from "./config.js";

let lastRequestTime = 0;

/** Ensure cache directory exists */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** Generate a cache key from a URL */
function cacheKey(url: string): string {
  const hash = createHash("md5").update(url).digest("hex");
  return join(CACHE_DIR, `${hash}.html`);
}

/** Check if URL is cached */
export function isCached(url: string): boolean {
  return existsSync(cacheKey(url));
}

/** Read from cache */
function readCache(url: string): string | null {
  const path = cacheKey(url);
  if (existsSync(path)) {
    return readFileSync(path, "utf-8");
  }
  return null;
}

/** Write to cache */
function writeCache(url: string, html: string): void {
  ensureCacheDir();
  writeFileSync(cacheKey(url), html, "utf-8");
}

/** Sleep for ms */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a URL with rate limiting and caching.
 * Returns the HTML content as a string.
 */
export async function fetchPage(url: string, skipCache = false): Promise<string> {
  // Check cache first
  if (!skipCache) {
    const cached = readCache(url);
    if (cached) return cached;
  }

  // Rate limit
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }

  // Fetch with retries
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": "IPLSimulator/1.0 (cricket rating research project; polite scraper)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Cache 404s too to avoid re-fetching
          writeCache(url, "<!-- 404 NOT FOUND -->");
          return "";
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      writeCache(url, html);
      return html;
    } catch (err) {
      lastError = err as Error;
      console.error(`  Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${url}: ${lastError.message}`);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/** Fetch count of cached pages */
export function getCacheStats(): { total: number } {
  ensureCacheDir();
  const { readdirSync } = require("fs");
  try {
    const files = readdirSync(CACHE_DIR);
    return { total: files.length };
  } catch {
    return { total: 0 };
  }
}
