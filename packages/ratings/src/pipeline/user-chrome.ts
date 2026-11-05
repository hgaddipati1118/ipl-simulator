/**
 * Drive the user's running Chrome for scraping, through the browser-harness daemon.
 *
 * Both sources refuse scripted browsers / plain HTTP:
 *   - ESPNCricinfo: Akamai returns "Access Denied" to a fresh Playwright profile and to curl.
 *   - CricketArchive: paywalled since Aug 2026; only a logged-in subscriber session gets pages.
 * The user's everyday Chrome passes both, so we fetch from inside a tab on the right origin
 * (same cookies, same TLS fingerprint).
 *
 * Two rules, both from the user:
 *   - No "Allow remote debugging?" prompts. Chrome asks once per new CDP client, so we never
 *     open our own connection; every command goes through the browser-harness daemon
 *     (BU_NAME=ipl-scraper), which holds one approved, long-lived connection.
 *   - One scraper window, kept open. Every run reuses the same window with one tab per site
 *     (ids saved in data/scraped/scraper-window.json). Code never opens extra windows or
 *     closes tabs; if the user closes the window, the next run recreates it once.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { join } from 'path';

const BU_NAME = process.env.SCRAPER_BU_NAME ?? 'ipl-scraper';
const DAEMON_SOCKET = `/tmp/bu-${BU_NAME}.sock`;
const STATE_DIR = new URL('../../data/scraped', import.meta.url).pathname;
const WINDOW_STATE_FILE = join(STATE_DIR, 'scraper-window.json');
const WINDOW_LOCK_DIR = join(STATE_DIR, '.scraper-window.lock');
const REQUEST_TIMEOUT_MS = 90_000;

/** The subset of Playwright's Page the scrapers use, so either backend can drive them. */
export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  close(): Promise<void>;
  isClosed(): boolean;
}

// ── Daemon transport ─────────────────────────────────────────────────────

function daemonRequest(req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(DAEMON_SOCKET);
    let data = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`browser-harness daemon request timed out: ${JSON.stringify(req).slice(0, 80)}`));
    }, REQUEST_TIMEOUT_MS);
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', chunk => {
      data += chunk.toString('utf-8');
      if (!data.endsWith('\n')) return;
      clearTimeout(timer);
      sock.end();
      const res = JSON.parse(data);
      if (res.error) reject(new Error(`CDP ${res.error}`));
      else resolve(res);
    });
    sock.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/** Errors meaning the daemon's own websocket to Chrome is gone (it doesn't reconnect by itself) */
const DEAD_CONNECTION = /no close frame|cdp_disconnected|ConnectionClosed|not connected|ECONNREFUSED|ENOENT/i;
let restarting: Promise<void> | null = null;

async function restartDaemon(): Promise<void> {
  restarting ??= (async () => {
    console.error('  [chrome] daemon lost its Chrome connection; restarting it (Chrome may ask to allow once)');
    await daemonRequest({ meta: 'shutdown' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    await ensureDaemon();
  })().finally(() => { restarting = null; });
  return restarting;
}

async function cdp(method: string, params: object = {}, sessionId?: string): Promise<any> {
  try {
    const res = await daemonRequest({ method, params, ...(sessionId ? { session_id: sessionId } : {}) });
    return res.result ?? {};
  } catch (err) {
    if (!DEAD_CONNECTION.test((err as Error).message)) throw err;
    await restartDaemon();
    // Sessions belong to the old connection; callers re-attach (DaemonPage does this itself)
    throw new SessionLostError((err as Error).message);
  }
}

class SessionLostError extends Error {}

async function ensureDaemon(): Promise<void> {
  try {
    if ((await daemonRequest({ meta: 'ping' })).pong) return;
  } catch {
    // not running yet
  }
  // browser-harness auto-starts its daemon on first use; Chrome may ask to allow it once
  execFileSync('browser-harness', [], {
    input: "print('daemon ready')\n",
    env: { ...process.env, BU_NAME },
    stdio: ['pipe', 'ignore', 'inherit'],
    timeout: 120_000,
  });
}

// ── Scraper window ───────────────────────────────────────────────────────

type WindowState = Record<string, string>; // origin -> targetId

function loadWindowState(): WindowState {
  return existsSync(WINDOW_STATE_FILE) ? JSON.parse(readFileSync(WINDOW_STATE_FILE, 'utf-8')) : {};
}

function saveWindowState(state: WindowState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2));
}

/** Serialize tab creation across scraper processes so two runs can't each make a window */
async function withWindowLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(WINDOW_LOCK_DIR);
      break;
    } catch {
      if (i > 120) rmSync(WINDOW_LOCK_DIR, { recursive: true, force: true }); // stale lock
      await new Promise(r => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(WINDOW_LOCK_DIR, { recursive: true, force: true });
  }
}

async function liveTargets(): Promise<{ targetId: string; url: string; openerId?: string; type: string }[]> {
  return (await cdp('Target.getTargets')).targetInfos ?? [];
}

/** Find (or create, once) the scraper window's tab for `origin` and return its target id. */
async function tabFor(origin: string): Promise<string> {
  return withWindowLock(async () => {
    const state = loadWindowState();
    const live = new Set((await liveTargets()).filter(t => t.type === 'page').map(t => t.targetId));
    for (const key of Object.keys(state)) if (!live.has(state[key])) delete state[key];

    if (state[origin]) return state[origin];

    // Reuse a tab already on this site (e.g. one opened before a reconnect) instead of opening another
    const host = new URL(origin).hostname.replace(/^www\./, '');
    const claimed = new Set(Object.values(state));
    const onSite = (t: { url: string; targetId: string; type: string }) => {
      if (t.type !== 'page' || claimed.has(t.targetId)) return false;
      try { return new URL(t.url).hostname.replace(/^www\./, '').endsWith(host); } catch { return false; }
    };
    const existing = (await liveTargets()).filter(onSite);
    // Close any duplicates left over from earlier runs, keep one
    for (const extra of existing.slice(1)) await cdp('Target.closeTarget', { targetId: extra.targetId }).catch(() => {});
    if (existing[0]) {
      state[origin] = existing[0].targetId;
      saveWindowState(state);
      return existing[0].targetId;
    }

    const sibling = Object.values(state)[0];
    let targetId: string;
    if (sibling) {
      // Open as a tab in the existing scraper window (CDP can't target a window directly)
      const before = new Set((await liveTargets()).map(t => t.targetId));
      const { sessionId } = await cdp('Target.attachToTarget', { targetId: sibling, flatten: true });
      await cdp('Runtime.evaluate', { expression: `window.open(${JSON.stringify(origin)}, '_blank'); 1`, userGesture: true }, sessionId);
      let found: string | undefined;
      for (let i = 0; i < 40 && !found; i++) {
        await new Promise(r => setTimeout(r, 250));
        // Any new page tab counts (openerId isn't always set), so a retry never opens a second one
        found = (await liveTargets()).find(t => t.type === 'page' && !before.has(t.targetId))?.targetId;
      }
      targetId = found ?? (await cdp('Target.createTarget', { url: origin, newWindow: true, background: true })).targetId;
    } else {
      // First tab of the session: one background window, so the user's own window keeps focus
      targetId = (await cdp('Target.createTarget', { url: origin, newWindow: true, background: true })).targetId;
    }
    state[origin] = targetId;
    saveWindowState(state);
    return targetId;
  });
}

/** The tab's session is gone: the daemon reconnected, or Chrome restarted / the tab was closed */
const STALE_SESSION = /Session with given id not found|No target with given id/i;

class DaemonPage implements BrowserPage {
  constructor(private origin: string, private targetId: string, private sessionId: string) {}

  /** Run a CDP call on this tab; if its session went stale, re-attach (recreating the tab if needed) and retry once */
  private async send(method: string, params: object): Promise<any> {
    try {
      return await cdp(method, params, this.sessionId);
    } catch (err) {
      if (!(err instanceof SessionLostError) && !STALE_SESSION.test((err as Error).message)) throw err;
      await this.reattach();
      return cdp(method, params, this.sessionId);
    }
  }

  private async reattach(): Promise<void> {
    try {
      this.sessionId = (await cdp('Target.attachToTarget', { targetId: this.targetId, flatten: true })).sessionId;
    } catch (err) {
      if (!STALE_SESSION.test((err as Error).message)) throw err;
      console.error(`  [chrome] scraper tab for ${this.origin} is gone; reopening it`);
      this.targetId = await tabFor(this.origin);
      this.sessionId = (await cdp('Target.attachToTarget', { targetId: this.targetId, flatten: true })).sessionId;
      await cdp('Page.navigate', { url: this.origin }, this.sessionId);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  async goto(url: string, options: { waitUntil?: string; timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? 30_000;
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    const wanted = options.waitUntil === 'load' ? ['complete'] : ['interactive', 'complete'];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
      const state = await this.evaluate(() => document.readyState).catch(() => 'loading');
      if (wanted.includes(state)) return;
    }
    throw new Error(`Timed out loading ${url}`);
  }

  title(): Promise<string> {
    return this.evaluate(() => document.title);
  }

  async evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    // tsx/esbuild may wrap named functions in __name(); define it so serialized code runs in the page
    const expression = `(() => { var __name = (f) => f; return (${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)}); })()`;
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`Page evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result?.value as R;
  }

  /** The scraper window is shared and persistent; never close its tabs */
  async close(): Promise<void> {}

  isClosed(): boolean {
    return false;
  }
}

export interface UserChrome {
  /** The scraper window's tab for this URL's site, navigated there if needed. Shared, not closed. */
  openPage(url?: string): Promise<BrowserPage>;
  /** Nothing to tear down: the daemon keeps the connection, the window stays open. */
  close(): Promise<void>;
}

export async function connectUserChrome(): Promise<UserChrome> {
  await ensureDaemon();
  const pages = new Map<string, DaemonPage>();

  async function openPage(url = 'about:blank'): Promise<BrowserPage> {
    const origin = new URL(url).origin + '/';
    const cached = pages.get(origin);
    if (cached) return cached;

    const targetId = await tabFor(origin);
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    const page = new DaemonPage(origin, targetId, sessionId);
    const href = await page.evaluate(() => location.href).catch(() => '');
    if (!href.startsWith(origin)) await page.goto(origin);
    pages.set(origin, page);
    return page;
  }

  return { openPage, close: async () => {} };
}

/** Fetch a same-origin URL from inside `page`, so the request carries the page's cookies. */
export async function fetchInPage(page: BrowserPage, url: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (target: string) => {
    const res = await fetch(target, { credentials: 'include' });
    return { status: res.status, text: await res.text() };
  }, url);
}
