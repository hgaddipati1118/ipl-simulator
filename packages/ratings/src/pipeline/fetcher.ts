/**
 * Rate-limited HTTP fetcher with local file caching.
 * Respects CricketArchive's server by spacing requests.
 *
 * CricketArchive went behind a paywall in Aug 2026 (anonymous requests get a 403
 * "Paywall" page), so requests go through a tab in the user's Chrome, where they're
 * logged in as a subscriber. See user-chrome.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import {
  BASE_URL, CACHE_DIR, REQUEST_DELAY_MS, MAX_RETRIES, RETRY_BACKOFF_MS,
  FETCH_SLOTS, MIN_REQUEST_DELAY_MS, MAX_REQUEST_DELAY_MS, SPEEDUP_EVERY,
} from "./config.js";
import { connectUserChrome, fetchInPage, type BrowserPage, type UserChrome } from "./user-chrome.js";

// ── Adaptive pacing: FETCH_SLOTS parallel slots, each waiting `gapMs` between requests ──
let gapMs = REQUEST_DELAY_MS;
let successStreak = 0;
const slotReadyAt: number[] = Array(FETCH_SLOTS).fill(0);
const slotBusy: boolean[] = Array(FETCH_SLOTS).fill(false);
const slotWaiters: (() => void)[] = [];

async function acquireSlot(): Promise<number> {
  for (;;) {
    const free = slotBusy.map((busy, i) => (busy ? -1 : i)).filter(i => i >= 0);
    if (free.length > 0) {
      const slot = free.reduce((a, b) => (slotReadyAt[a] <= slotReadyAt[b] ? a : b));
      slotBusy[slot] = true;
      const wait = slotReadyAt[slot] - Date.now();
      if (wait > 0) await sleep(wait);
      return slot;
    }
    await new Promise<void>(resolve => slotWaiters.push(resolve));
  }
}

function releaseSlot(slot: number, ok: boolean): void {
  if (ok) {
    // After a long backoff, recover quickly: halve the gap every 5 successes while it's over 2s
    const slow = gapMs > 2000;
    if (++successStreak >= (slow ? 5 : SPEEDUP_EVERY) && gapMs > MIN_REQUEST_DELAY_MS) {
      gapMs = Math.max(MIN_REQUEST_DELAY_MS, Math.round(gapMs * (slow ? 0.5 : 0.85)));
      console.log(`  [pace] ${SPEEDUP_EVERY} ok in a row -> gap ${gapMs}ms x ${FETCH_SLOTS} slots`);
      successStreak = 0;
    }
  } else {
    gapMs = Math.min(MAX_REQUEST_DELAY_MS, gapMs * 2);
    successStreak = 0;
    console.log(`  [pace] failure -> backing off, gap ${gapMs}ms`);
  }
  slotReadyAt[slot] = Date.now() + gapMs;
  slotBusy[slot] = false;
  slotWaiters.shift()?.();
}
let chrome: UserChrome | null = null;
let archivePage: BrowserPage | null = null;

/** Thrown when CricketArchive serves its paywall, i.e. Chrome isn't logged in. */
export class PaywallError extends Error {}

async function getArchivePage(): Promise<BrowserPage> {
  if (archivePage && !archivePage.isClosed()) return archivePage;
  chrome ??= await connectUserChrome();
  archivePage = await chrome.openPage(`${BASE_URL}/`);
  return archivePage;
}

/**
 * The site sometimes moves the tab to my.cricketarchive.com (account pages, e.g. a session
 * refresh); same-origin fetches from there fail with "Failed to fetch". Send it back home.
 */
async function ensureOnArchiveOrigin(page: BrowserPage): Promise<void> {
  const origin = await page.evaluate(() => location.origin).catch(() => "");
  if (origin === new URL(BASE_URL).origin) return;
  console.error(`  [archive] tab had moved to ${origin || "an unknown page"}; returning to ${BASE_URL}`);
  await page.goto(`${BASE_URL}/`).catch(() => {});
  await sleep(3000);
}

/**
 * Run `fn` over items with one worker per fetch slot, so both slots stay busy.
 * Stops early once `stop()` returns true; errors thrown by `fn` stop everything.
 */
export async function forEachConcurrent<T>(items: T[], fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: FETCH_SLOTS }, worker));
}

/** Disconnect from Chrome so the process can exit. Safe to call when never connected. */
export async function closeFetcher(): Promise<void> {
  if (chrome) await chrome.close();
  chrome = null;
  archivePage = null;
}

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
 * The paywall also shows up as a temporary block while still logged in (seen twice on
 * 2026-10-31: after ~5h and after ~25min of scraping, each clearing within minutes), so
 * wait with escalating pauses, holding every other fetch back too, before treating it as
 * a real logout.
 */
const PAYWALL_BACKOFF_MIN = [1, 2, 5, 10, 20, 30, 60];
let paywallWait: Promise<void> | null = null;

async function waitOutPaywall(url: string): Promise<{ status: number; text: string }> {
  paywallWait ??= (async () => {
    for (const minutes of PAYWALL_BACKOFF_MIN) {
      console.error(`  [paywall] CricketArchive is showing its paywall; pausing ${minutes} min`);
      gapMs = Math.min(MAX_REQUEST_DELAY_MS, gapMs * 2);
      await sleep(minutes * 60_000);
      const page = await getArchivePage();
      await page.goto(`${BASE_URL}/`).catch(() => {});
      const probe = await fetchInPage(page, url);
      if (!(probe.status === 403 && probe.text.includes("Paywall"))) {
        console.error(`  [paywall] cleared; resuming`);
        return;
      }
    }
    throw new PaywallError(
      "CricketArchive still returns its paywall after an hour of waiting: log in to cricketarchive.com in Chrome, then re-run.",
    );
  })().finally(() => { paywallWait = null; });
  // Concurrent fetches share one wait, then each refetches its own URL
  await paywallWait;
  return fetchInPage(await getArchivePage(), url);
}

/**
 * Fetch a URL with rate limiting and caching.
 * Returns the HTML content as a string.
 * `store: false` skips writing the page to the cache (for the ~1M minor-cricket pages,
 * whose parsed form is kept instead: their HTML would not fit on disk).
 */
export async function fetchPage(url: string, skipCache = false, { store = true }: { store?: boolean } = {}): Promise<string> {
  // Check cache first
  if (!skipCache) {
    const cached = readCache(url);
    if (cached) return cached;
  }

  // Fetch with retries; every attempt takes a paced slot and reports back how it went
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const slot = await acquireSlot();
    let ok = false;
    try {
      const archive = await getArchivePage();
      let response = await fetchInPage(archive, url).catch(async err => {
        // A fetch that fails outright usually means the tab left the site; recover and retry once
        await ensureOnArchiveOrigin(archive);
        return fetchInPage(archive, url).catch(() => { throw err; });
      });

      if (response.status === 403 && response.text.includes("Paywall")) {
        // Seen once mid-session while still logged in: reload the homepage to refresh
        // the session, then retry before treating it as logged out
        const page = await getArchivePage();
        await page.goto(`${BASE_URL}/`);
        await sleep(RETRY_BACKOFF_MS);
        response = await fetchInPage(page, url);
      }
      if (response.status === 403 && response.text.includes("Paywall")) {
        response = await waitOutPaywall(url);
      }
      if (response.status !== 200) {
        if (response.status === 404) {
          // Cache 404s too to avoid re-fetching
          if (store) writeCache(url, "<!-- 404 NOT FOUND -->");
          ok = true;
          return "";
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const html = response.text;
      if (store) writeCache(url, html);
      ok = true;
      return html;
    } catch (err) {
      if (err instanceof PaywallError) throw err;
      lastError = err as Error;
      console.error(`  Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${url}: ${lastError.message}`);
    } finally {
      releaseSlot(slot, ok);
    }
    // Wait outside the slot so the other slot keeps working
    if (attempt < MAX_RETRIES - 1) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
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
