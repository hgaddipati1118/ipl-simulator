/**
 * Fetch pages through the Aside browser's REPL (`aside repl`), the alternative to driving
 * the user's Chrome over CDP (which needs Chrome's "Allow remote debugging" prompt).
 *
 * The REPL runs at most 120s per call and closes tabs it opened when the call returns, so
 * work is batched: one call opens a tab on the site, waits for Akamai's sensor cookie,
 * fetches a batch of same-origin paths from inside the page, prints the results, and closes
 * the tab. Only the REPL is used; `aside exec` spends Aside agent credits.
 */

import { execFile } from 'child_process';
import { tmpdir } from 'os';

const MARK = '@@ASIDE_RESULT@@';

export interface AsideFetchResult {
  path: string;
  status: number;
  /** Response body, or `extract(body)` when an extractor was given */
  text: string;
}

export interface AsideBatchOptions {
  /** Wait after the tab loads, so bot-protection cookies are set (ms) */
  settleMs?: number;
  /** Requests in flight at once inside the page */
  parallel?: number;
  /** Pause between requests on each lane (ms) */
  gapMs?: number;
  /**
   * In-page `(body: string) => string`, applied before results leave the browser to keep
   * stdout small. Serialized with toString(), so it must not reference outer variables.
   */
  extract?: (body: string) => string;
}

function runRepl(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('aside', ['repl', code], { cwd: tmpdir(), timeout: 150_000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout.includes(MARK)) reject(new Error(`aside repl failed: ${(stderr || stdout || err.message).slice(-300)}`));
      else resolve(stdout);
    });
  });
}

/**
 * The in-page fetch loop as one expression string, with the extractor inlined (no eval, so
 * page CSP can't block it; __name covers esbuild's wrapper around named functions).
 */
function pageScript(paths: string[], parallel: number, gapMs: number, extract?: (body: string) => string): string {
  return `(async () => {
    var __name = (f) => f;
    const extract = ${extract ? extract.toString() : 'null'};
    const paths = ${JSON.stringify(paths)};
    const results = [];
    let next = 0;
    const lane = async () => {
      while (next < paths.length) {
        const path = paths[next++];
        try {
          const res = await fetch(path, { credentials: 'include' });
          const body = await res.text();
          results.push({ path, status: res.status, text: extract && res.status === 200 ? extract(body) : body });
        } catch (err) {
          results.push({ path, status: 0, text: String(err) });
        }
        await new Promise(r => setTimeout(r, ${gapMs}));
      }
    };
    await Promise.all(Array.from({ length: ${parallel} }, lane));
    return results;
  })()`;
}

/** Fetch `paths` (same-origin, relative) from a fresh Aside tab on `origin`. */
export async function asideFetchBatch(origin: string, paths: string[], options: AsideBatchOptions = {}): Promise<AsideFetchResult[]> {
  const { settleMs = 8000, parallel = 2, gapMs = 800, extract } = options;
  const id = Math.random().toString(36).slice(2, 10);
  // Fresh names per call: REPL bindings persist across calls
  const code = `
const tab_${id} = await openTab(${JSON.stringify(origin)});
try {
  await sleep(${settleMs});
  const out_${id} = await tab_${id}.evaluate(${JSON.stringify(pageScript(paths, parallel, gapMs, extract))});
  console.log(${JSON.stringify(MARK)} + JSON.stringify(out_${id}));
} finally {
  await closeTab(tab_${id});
}`;
  const stdout = await runRepl(code);
  const line = stdout.split('\n').find(l => l.includes(MARK));
  if (!line) throw new Error(`aside repl returned no result: ${stdout.slice(-300)}`);
  return JSON.parse(line.slice(line.indexOf(MARK) + MARK.length));
}
