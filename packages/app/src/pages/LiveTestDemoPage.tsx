/**
 * Dev route for Test cricket (/live-test) until the International series page offers Tests: pick two national sides (from the
 * shipped pool on Test ratings), the side to captain and a seed, then play live (LiveTestPage), simulate instantly (the
 * scorecard), or resume the saved match. Query parameters start a match straight away for tests:
 * /live-test?home=India&away=England&user=home&seed=7&start=live|instant
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { TestMatchResult, TestMatchState } from "@ipl-sim/engine";
import { loadFormatRatings } from "../format-ratings";
import { TEST_NATIONS, buildNationalTeam } from "../test-match/national-teams";
import { playTestInstantly, startTestLive } from "../test-match/test-entry";
import { clearLiveTest, loadLiveTest } from "../test-match/test-db";
import { LiveTestPage } from "./LiveTestPage";
import { TestScorecard } from "../test-match/TestScorecard";

const SAVE_KEY = "dev-route";

export function LiveTestDemoPage() {
  const [params] = useSearchParams();
  const [home, setHome] = useState(params.get("home") ?? "India");
  const [away, setAway] = useState(params.get("away") ?? "England");
  const [user, setUser] = useState<"home" | "away">(params.get("user") === "away" ? "away" : "home");
  const [seed, setSeed] = useState(params.get("seed") ?? "");
  const [live, setLive] = useState<TestMatchState | null>(null);
  const [instant, setInstant] = useState<TestMatchResult | null>(null);
  const [saved, setSaved] = useState<TestMatchState | null>(null);
  const [loading, setLoading] = useState(false);

  const colors = useMemo(() => Object.fromEntries(TEST_NATIONS.map(n => [`test-${n.short.toLowerCase()}`, n.color])), []);

  useEffect(() => { void loadLiveTest(SAVE_KEY).then(setSaved); }, []);

  const build = async () => {
    const file = await loadFormatRatings();
    const h = TEST_NATIONS.find(n => n.name === home)!;
    const a = TEST_NATIONS.find(n => n.name === away)!;
    return { setup: { home: buildNationalTeam(h, file), away: buildNationalTeam(a, file), country: h.country, venueName: `${h.name} (home Test)`, seed: seed ? Number(seed) : undefined } };
  };

  const playLive = async () => {
    setLoading(true);
    const { setup } = await build();
    await clearLiveTest(SAVE_KEY);
    setLive(startTestLive(setup, user === "home" ? setup.home.id : setup.away.id));
    setLoading(false);
  };
  const simInstant = async () => {
    setLoading(true);
    const { setup } = await build();
    setInstant(playTestInstantly(setup));
    setLoading(false);
  };

  // ?start=live / instant: straight in (tests)
  useEffect(() => {
    const start = params.get("start");
    if (start === "live") void playLive();
    if (start === "instant") void simInstant();
  }, []);

  if (live) return <LiveTestPage state={live} saveKey={SAVE_KEY} colors={colors} title="Test match (dev)" onExit={() => { setLive(null); void loadLiveTest(SAVE_KEY).then(setSaved); }} />;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8" data-testid="live-test-setup">
      <div className="text-[11px] uppercase tracking-widest text-th-muted font-display">Development</div>
      <h1 className="text-2xl font-display font-extrabold text-th-primary mb-1">Test match</h1>
      <p className="text-sm text-th-muted mb-6">Two national sides from the player pool on their Test ratings. Five days, two innings a side.</p>

      <div className="rounded-2xl border border-th bg-th-surface p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {([["Home side", home, setHome], ["Away side", away, setAway]] as const).map(([label, value, set]) => (
          <label key={label} className="text-xs text-th-muted font-display">
            {label}
            <select value={value} onChange={e => set(e.target.value)} className="mt-1 w-full bg-th-body border border-th rounded-lg px-3 py-2 text-sm text-th-primary">
              {TEST_NATIONS.map(n => <option key={n.name} value={n.name}>{n.name}</option>)}
            </select>
          </label>
        ))}
        <label className="text-xs text-th-muted font-display">
          You captain
          <select value={user} onChange={e => setUser(e.target.value as "home" | "away")} className="mt-1 w-full bg-th-body border border-th rounded-lg px-3 py-2 text-sm text-th-primary">
            <option value="home">{home} (home)</option>
            <option value="away">{away} (away)</option>
          </select>
        </label>
        <label className="text-xs text-th-muted font-display">
          Seed (optional)
          <input value={seed} onChange={e => setSeed(e.target.value.replace(/\D/g, ""))} placeholder="random" className="mt-1 w-full bg-th-body border border-th rounded-lg px-3 py-2 text-sm text-th-primary" />
        </label>
        <div className="sm:col-span-2 flex flex-wrap gap-3 pt-2">
          <button disabled={loading || home === away} onClick={() => void playLive()} data-testid="live-test-play"
            className="px-5 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white font-display font-semibold rounded-xl text-sm disabled:opacity-40">
            Play live
          </button>
          <button disabled={loading || home === away} onClick={() => void simInstant()} data-testid="live-test-instant"
            className="px-5 py-2.5 bg-th-hover text-th-primary font-display font-semibold rounded-xl border border-th text-sm hover:bg-th-body disabled:opacity-40">
            Simulate instantly
          </button>
          {saved && saved.status !== "completed" && (
            <button onClick={() => setLive(saved)} data-testid="live-test-resume"
              className="px-5 py-2.5 bg-th-hover text-emerald-400 font-display font-semibold rounded-xl border border-emerald-500/30 text-sm hover:bg-th-body">
              Resume {saved.teams[saved.teamOrder[0]].shortName} v {saved.teams[saved.teamOrder[1]].shortName} (day {saved.day})
            </button>
          )}
          {loading && <span className="text-xs text-th-muted font-display self-center">Picking the XIs…</span>}
        </div>
      </div>

      {instant && (
        <div className="mt-6">
          <TestScorecard st={instant.state} colors={colors} />
        </div>
      )}
    </div>
  );
}

export default LiveTestDemoPage;
