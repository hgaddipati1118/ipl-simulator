/**
 * The live Test screen and scorecard (pages/LiveTestPage.tsx, test-match/): the view helpers, the entry points the
 * International series page calls, the national sides of the dev route, and the page and scorecard server-rendered. Seeded,
 * so deterministic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  advanceTest, autoResolveTestDecision, currentTestInnings, decideTest, deserializeTestState, serializeTestState, setTestAutoCaptain,
  type TestMatchState,
} from "@ipl-sim/engine";
import type { FormatRatingsFile } from "@ipl-sim/ratings/dist/format-ratings.js";
import { TEST_NATIONS, buildNationalTeam } from "../test-match/national-teams";
import { playTestInstantly, startTestLive } from "../test-match/test-entry";
import {
  ballChip, buildFeed, decisionView, inningsScore, partnership, statusLine, teamScoreLine,
} from "../test-match/test-view";
import { LiveTestPage } from "../pages/LiveTestPage";
import { TestScorecard } from "../test-match/TestScorecard";

const formatFile: FormatRatingsFile = JSON.parse(readFileSync(new URL("../../public/data/format-ratings.json", import.meta.url), "utf8"));
const IND = buildNationalTeam(TEST_NATIONS[0], formatFile);
const ENG = buildNationalTeam(TEST_NATIONS[1], formatFile);
const setup = (seed: number) => ({ home: IND, away: ENG, country: "IND", venueName: "Chennai", seed });

const html = (el: ReturnType<typeof createElement>) => renderToString(createElement(MemoryRouter, null, el)).replace(/<!-- -->/g, "");

/** Play on, answering every decision with the CPU's answer, until `until` is true */
function playUntil(st: TestMatchState, until: (s: TestMatchState) => boolean, max = 5000) {
  for (let g = 0; g < max && !until(st) && st.status !== "completed"; g++) {
    if (st.status === "waiting_for_decision") autoResolveTestDecision(st);
    else advanceTest(st, "ball");
  }
}

describe("national sides for the dev route", () => {
  it("16 players with a keeper, on their Test ratings", () => {
    for (const t of [IND, ENG]) {
      expect(t.roster.length).toBe(16);
      expect(t.roster.some(p => p.isWicketKeeper)).toBe(true);
      expect(t.roster.filter(p => p.formatRatings?.test).length).toBeGreaterThan(12);
    }
  });
});

describe("entry points", () => {
  it("an instant Test returns the result, scorecards and the final state", () => {
    const r = playTestInstantly(setup(3));
    expect(r.state.status).toBe("completed");
    expect(r.scorecards.length).toBe(r.state.innings.length);
    expect(["win", "draw", "tie"]).toContain(r.result.kind);
    expect(r.result.text.length).toBeGreaterThan(5);
  });

  it("a live Test waits for the user's toss call when he wins it, else is ready to play", () => {
    let waited = 0, ready = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const st = startTestLive(setup(seed), IND.id);
      if (st.status === "waiting_for_decision") { expect(st.pending!.type).toBe("toss"); waited++; }
      else { expect(st.status).toBe("in_progress"); ready++; }
      expect(st.commentary).toBe(true);
    }
    expect(waited).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(0);
  });

  it("a saved live Test resumes exactly", () => {
    const a = startTestLive(setup(5), ENG.id);
    playUntil(a, s => s.matchBalls > 400);
    const b = deserializeTestState(serializeTestState(a));
    setTestAutoCaptain(a, true); setTestAutoCaptain(b, true);
    advanceTest(a, "match", { autoDecide: true });
    advanceTest(b, "match", { autoDecide: true });
    expect(b.result!.text).toBe(a.result!.text);
  });
});

describe("view helpers", () => {
  const r = playTestInstantly(setup(9));
  const st = r.state;

  it("score lines: innings joined by &, declarations and follow-ons marked", () => {
    for (const id of st.teamOrder) {
      const line = teamScoreLine(st, id);
      const inns = st.innings.filter(i => i.battingTeamId === id);
      expect(line.split(" & ").length).toBe(inns.length);
      inns.forEach(i => expect(line).toContain(inningsScore(i)));
    }
    const declared = { ...st.innings[0], closed: "declared" as const, runs: 401, wickets: 7 };
    expect(inningsScore(declared)).toBe("401/7d");
    expect(inningsScore({ ...st.innings[0], closed: "all_out", runs: 250, wickets: 10 })).toBe("250");
  });

  it("the status line ends with the result", () => {
    expect(statusLine(st)).toBe(r.result.text);
  });

  it("partnership counts runs and legal balls since the last wicket", () => {
    const inn = st.innings[0];
    const p = partnership(inn);
    const lastW = inn.ballLog.map(e => e.isWicket).lastIndexOf(true);
    const after = inn.ballLog.slice(lastW + 1);
    expect(p.runs).toBe(after.reduce((a, e) => a + e.runs + e.extras, 0));
  });

  it("ball chips", () => {
    const ev = st.innings[0].ballLog.find(e => e.isWicket)!;
    expect(ballChip(ev)).toEqual({ label: "W", kind: "wicket" });
    const four = st.innings[0].ballLog.find(e => e.boundary === 4 && !e.isWicket);
    if (four) expect(ballChip(four).kind).toBe("four");
  });

  it("the feed is newest first, with innings headings, the toss last and events placed", () => {
    const feed = buildFeed(st, 5000);
    expect(feed[feed.length - 1]).toMatchObject({ kind: "event" });
    expect(feed.filter(f => f.kind === "innings").length).toBe(st.innings.length);
    const balls = feed.filter(f => f.kind === "ball");
    expect(balls.length).toBe(st.innings.reduce((a, i) => a + i.ballLog.length, 0));
    expect(feed.some(f => f.kind === "event" && f.event.kind === "result")).toBe(true);
    // a short feed is capped
    expect(buildFeed(st, 20).filter(f => f.kind === "ball").length).toBe(20);
  });

  it("every decision has wording and its options", () => {
    const live = startTestLive(setup(1), IND.id);
    if (live.pending) {
      const v = decisionView(live, live.pending);
      expect(v.options.map(o => o.value)).toEqual(["bat", "bowl"]);
      decideTest(live, "bat");
    }
    playUntil(live, s => s.status === "waiting_for_decision" && s.pending?.type !== "toss");
    if (live.pending) {
      const v = decisionView(live, live.pending);
      expect(v.title.length).toBeGreaterThan(3);
      expect(v.options.length).toBe(live.pending.options.length);
    }
  });
});

describe("rendered", () => {
  it("the live page: scoreboard, controls, captain panel and commentary", () => {
    const st = startTestLive(setup(2), IND.id);
    if (st.pending?.type === "toss") decideTest(st, "bat");
    playUntil(st, s => s.matchBalls >= 60 && s.status === "in_progress");
    const out = html(createElement(LiveTestPage, { state: st, colors: { [IND.id]: "#3b82f6" } }));
    for (const id of ["live-test-page", "test-scoreboard", "test-score", "test-session", "test-controls", "test-skip-over", "test-skip-session", "test-skip-day", "test-skip-match", "test-captain", "test-commentary", "test-ball"]) {
      expect(out).toContain(`data-testid="${id}"`);
    }
    const inn = currentTestInnings(st)!;
    expect(out).toContain(`${inn.runs}<span class="text-th-muted">/</span>${inn.wickets}`);
    expect(out).toContain("Day ");
  });

  it("the scorecard of a finished Test: result, both sides' innings, fall of wickets, bowling", () => {
    const r = playTestInstantly(setup(11));
    const out = html(createElement(TestScorecard, { st: r.state }));
    expect(out).toContain(`data-testid="test-result"`);
    expect(out).toContain(r.result.text.replace(/'/g, "&#x27;"));
    for (let i = 1; i <= r.state.innings.length; i++) expect(out).toContain(`data-testid="test-scorecard-tab-${i}"`);
    expect(out).toContain(`data-testid="test-fow"`);
    expect(out).toContain("Bowler");
    expect(out).toContain("Fall of wickets");
  });

  it("a drawn Test reads as a draw", () => {
    let drawn: ReturnType<typeof playTestInstantly> | null = null;
    for (let seed = 1; seed < 80 && !drawn; seed++) {
      const r = playTestInstantly({ ...setup(seed), days: 2 });
      if (r.result.kind === "draw") drawn = r;
    }
    expect(drawn).not.toBeNull();
    const out = html(createElement(TestScorecard, { st: drawn!.state }));
    expect(out).toContain("Match drawn");
  });
});
