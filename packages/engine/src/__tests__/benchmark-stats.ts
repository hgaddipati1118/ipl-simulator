/**
 * Benchmark Script: Simulate 1000 IPL matches and compare aggregate stats
 * to real IPL averages.
 *
 * Usage: npx tsx packages/engine/src/__tests__/benchmark-stats.ts
 */

import {
  Team,
  IPL_TEAMS,
  simulateMatch,
  createPlayerFromData,
  RULE_PRESETS,
  type InningsScore,
  type MatchResult,
  type RuleSet,
} from "@ipl-sim/engine";
import { getRealPlayers } from "../../../ratings/src/real-players.js";

// ── Helpers ──────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + " ".repeat(len - s.length);
}

function divider(char = "-", len = 80): string {
  return char.repeat(len);
}

// ── Build two realistic teams from real IPL rosters ─────────────────

function buildTeams(): [Team, Team] {
  const rules = RULE_PRESETS.modern;

  // Pick two teams with deep rosters: MI and CSK
  const miConfig = IPL_TEAMS.find(t => t.id === "mi")!;
  const cskConfig = IPL_TEAMS.find(t => t.id === "csk")!;

  const miTeam = new Team(miConfig, rules.salaryCap);
  const cskTeam = new Team(cskConfig, rules.salaryCap);

  const realPlayers = getRealPlayers();

  let miCount = 0;
  let cskCount = 0;

  for (const rp of realPlayers) {
    if (!rp.teamId) continue;

    const player = createPlayerFromData({
      name: rp.name,
      age: rp.age,
      country: rp.country,
      role: rp.role,
      isWicketKeeper: rp.isWicketKeeper,
      bowlingStyle: rp.bowlingStyle,
      battingHand: rp.battingHand,
      battingIQ: rp.battingIQ,
      timing: rp.timing,
      power: rp.power,
      running: rp.running,
      wicketTaking: rp.wicketTaking,
      economy: rp.economy,
      accuracy: rp.accuracy,
      clutch: rp.clutch,
      teamId: rp.teamId,
    });

    if (rp.teamId === "mi") {
      miTeam.addPlayer(player, player.bid || 1);
      miCount++;
    } else if (rp.teamId === "csk") {
      cskTeam.addPlayer(player, player.bid || 1);
      cskCount++;
    }
  }

  console.log(`MI roster: ${miCount} players`);
  console.log(`CSK roster: ${cskCount} players`);

  // Verify playing XI can be formed
  const miXI = miTeam.getPlayingXI();
  const cskXI = cskTeam.getPlayingXI();
  console.log(`MI Playing XI: ${miXI.length} players`);
  console.log(`CSK Playing XI: ${cskXI.length} players`);

  if (miXI.length < 11 || cskXI.length < 11) {
    console.error("ERROR: Cannot form a playing XI for one or both teams.");
    console.error("Falling back to all teams with full rosters...");
    // Try other team pairs
    throw new Error("Insufficient roster for MI or CSK");
  }

  return [miTeam, cskTeam];
}

// ── Main benchmark ──────────────────────────────────────────────────

function main(): void {
  const NUM_MATCHES = 1000;

  console.log(divider("="));
  console.log("     IPL SIMULATOR BENCHMARK: 1000 MATCHES");
  console.log(divider("="));

  const [teamA, teamB] = buildTeams();
  // Use modern rules but disable impact player and injuries for clean benchmarking
  const rules: RuleSet = {
    ...RULE_PRESETS.modern,
    impactPlayer: false,
    injuriesEnabled: false,
  };

  // Accumulators
  let totalFirstInningsRuns = 0;
  let totalSecondInningsRuns = 0;
  let totalFirstInningsBalls = 0;
  let totalSecondInningsBalls = 0;
  let totalFirstInningsWickets = 0;
  let totalSecondInningsWickets = 0;
  let totalFirstInningsFours = 0;
  let totalFirstInningsSixes = 0;
  let totalSecondInningsFours = 0;
  let totalSecondInningsSixes = 0;
  let batFirstWins = 0;
  let chaseWins = 0;
  let ties = 0;

  // Per-batter accumulation for strike rate
  let totalBatterRuns = 0;
  let totalBatterBalls = 0;

  // Per-bowler accumulation for economy
  let totalBowlerRuns = 0;
  let totalBowlerBalls = 0; // legal deliveries

  const startTime = Date.now();

  for (let i = 0; i < NUM_MATCHES; i++) {
    // Reset player stats between matches to avoid stat accumulation bugs
    for (const p of teamA.roster) p.resetSeasonStats();
    for (const p of teamB.roster) p.resetSeasonStats();

    // Alternate home/away
    const homeTeam = i % 2 === 0 ? teamA : teamB;
    const awayTeam = i % 2 === 0 ? teamB : teamA;

    const result: MatchResult = simulateMatch(homeTeam, awayTeam, rules);

    const inn1 = result.innings[0];
    const inn2 = result.innings[1];

    // First innings stats
    totalFirstInningsRuns += inn1.runs;
    totalFirstInningsBalls += inn1.totalBalls;
    totalFirstInningsWickets += inn1.wickets;
    totalFirstInningsFours += inn1.fours;
    totalFirstInningsSixes += inn1.sixes;

    // Second innings stats
    totalSecondInningsRuns += inn2.runs;
    totalSecondInningsBalls += inn2.totalBalls;
    totalSecondInningsWickets += inn2.wickets;
    totalSecondInningsFours += inn2.fours;
    totalSecondInningsSixes += inn2.sixes;

    // Batter-level stats from innings
    for (const [, bs] of inn1.batterStats) {
      totalBatterRuns += bs.runs;
      totalBatterBalls += bs.balls;
    }
    for (const [, bs] of inn2.batterStats) {
      totalBatterRuns += bs.runs;
      totalBatterBalls += bs.balls;
    }

    // Bowler-level stats from innings
    for (const [, bw] of inn1.bowlerStats) {
      totalBowlerRuns += bw.runs;
      totalBowlerBalls += bw.overs * 6 + bw.balls;
    }
    for (const [, bw] of inn2.bowlerStats) {
      totalBowlerRuns += bw.runs;
      totalBowlerBalls += bw.overs * 6 + bw.balls;
    }

    // Win tracking
    if (!result.winnerId) {
      ties++;
    } else {
      // The team that batted first is inn1.teamId
      const battingFirstTeamId = inn1.teamId;
      if (result.winnerId === battingFirstTeamId) {
        batFirstWins++;
      } else {
        chaseWins++;
      }
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  Simulated ${i + 1} / ${NUM_MATCHES} matches...`);
    }
  }

  const elapsed = Date.now() - startTime;

  // ── Compute aggregates ──────────────────────────────────────────

  const avgFirstInnings = totalFirstInningsRuns / NUM_MATCHES;
  const avgSecondInnings = totalSecondInningsRuns / NUM_MATCHES;
  const avgRunRateFirst = (totalFirstInningsRuns / totalFirstInningsBalls) * 6;
  const avgRunRateSecond = (totalSecondInningsRuns / totalSecondInningsBalls) * 6;
  const avgRunRate = ((totalFirstInningsRuns + totalSecondInningsRuns) / (totalFirstInningsBalls + totalSecondInningsBalls)) * 6;
  const avgWicketsPerMatch = (totalFirstInningsWickets + totalSecondInningsWickets) / NUM_MATCHES;
  const avgFirstInningsWickets = totalFirstInningsWickets / NUM_MATCHES;
  const avgSecondInningsWickets = totalSecondInningsWickets / NUM_MATCHES;
  const batFirstWinPct = (batFirstWins / (NUM_MATCHES - ties)) * 100;
  const chaseWinPct = (chaseWins / (NUM_MATCHES - ties)) * 100;

  const avgFoursPerInnings = (totalFirstInningsFours + totalSecondInningsFours) / (NUM_MATCHES * 2);
  const avgSixesPerInnings = (totalFirstInningsSixes + totalSecondInningsSixes) / (NUM_MATCHES * 2);
  const avgFoursFirst = totalFirstInningsFours / NUM_MATCHES;
  const avgSixesFirst = totalFirstInningsSixes / NUM_MATCHES;
  const avgFoursSecond = totalSecondInningsFours / NUM_MATCHES;
  const avgSixesSecond = totalSecondInningsSixes / NUM_MATCHES;

  const avgBatterSR = totalBatterBalls > 0 ? (totalBatterRuns / totalBatterBalls) * 100 : 0;
  const avgBowlerEcon = totalBowlerBalls > 0 ? (totalBowlerRuns / totalBowlerBalls) * 6 : 0;

  // ── Real IPL Benchmarks (2022-2025 averages) ────────────────────

  interface Benchmark {
    label: string;
    simulated: number;
    realLow: number;
    realHigh: number;
    unit: string;
  }

  const benchmarks: Benchmark[] = [
    { label: "Avg First Innings Score", simulated: avgFirstInnings, realLow: 165, realHigh: 175, unit: "" },
    { label: "Avg Second Innings Score", simulated: avgSecondInnings, realLow: 155, realHigh: 165, unit: "" },
    { label: "Overall Run Rate", simulated: avgRunRate, realLow: 8.5, realHigh: 9.5, unit: " rpo" },
    { label: "1st Innings Run Rate", simulated: avgRunRateFirst, realLow: 8.5, realHigh: 9.5, unit: " rpo" },
    { label: "2nd Innings Run Rate", simulated: avgRunRateSecond, realLow: 8.0, realHigh: 9.0, unit: " rpo" },
    { label: "Wickets per Match", simulated: avgWicketsPerMatch, realLow: 12, realHigh: 15, unit: "" },
    { label: "1st Inn Wickets Avg", simulated: avgFirstInningsWickets, realLow: 6, realHigh: 8, unit: "" },
    { label: "2nd Inn Wickets Avg", simulated: avgSecondInningsWickets, realLow: 6, realHigh: 8, unit: "" },
    { label: "Bat-First Win %", simulated: batFirstWinPct, realLow: 45, realHigh: 50, unit: "%" },
    { label: "Chase Win %", simulated: chaseWinPct, realLow: 50, realHigh: 55, unit: "%" },
    { label: "Avg Fours per Innings", simulated: avgFoursPerInnings, realLow: 12, realHigh: 16, unit: "" },
    { label: "Avg Sixes per Innings", simulated: avgSixesPerInnings, realLow: 5, realHigh: 9, unit: "" },
    { label: "Avg Batter Strike Rate", simulated: avgBatterSR, realLow: 135, realHigh: 145, unit: "" },
    { label: "Avg Bowler Economy", simulated: avgBowlerEcon, realLow: 8.0, realHigh: 9.0, unit: " rpo" },
  ];

  // ── Print results ──────────────────────────────────────────────

  console.log(`\n${divider("=")}`);
  console.log(`  RESULTS: ${NUM_MATCHES} matches simulated in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  (${(elapsed / NUM_MATCHES).toFixed(1)}ms per match)`);
  console.log(divider("="));

  console.log(`\n${pad("Stat", 30)} ${pad("Simulated", 12)} ${pad("Real IPL", 16)} ${pad("Verdict", 12)}`);
  console.log(divider("-", 72));

  for (const b of benchmarks) {
    const simStr = b.simulated.toFixed(1) + b.unit;
    const realStr = `${b.realLow}-${b.realHigh}${b.unit}`;

    let verdict: string;
    if (b.simulated >= b.realLow && b.simulated <= b.realHigh) {
      verdict = "OK";
    } else if (b.simulated < b.realLow) {
      const pctOff = ((b.realLow - b.simulated) / b.realLow * 100).toFixed(0);
      verdict = `LOW (-${pctOff}%)`;
    } else {
      const pctOff = ((b.simulated - b.realHigh) / b.realHigh * 100).toFixed(0);
      verdict = `HIGH (+${pctOff}%)`;
    }

    console.log(`${pad(b.label, 30)} ${pad(simStr, 12)} ${pad(realStr, 16)} ${verdict}`);
  }

  console.log(divider("-", 72));

  // ── Detailed breakdowns ────────────────────────────────────────

  console.log(`\nAdditional Detail:`);
  console.log(`  Avg Fours (1st inn): ${avgFoursFirst.toFixed(1)}  |  Avg Fours (2nd inn): ${avgFoursSecond.toFixed(1)}`);
  console.log(`  Avg Sixes (1st inn): ${avgSixesFirst.toFixed(1)}  |  Avg Sixes (2nd inn): ${avgSixesSecond.toFixed(1)}`);
  console.log(`  Bat-first wins: ${batFirstWins}  |  Chase wins: ${chaseWins}  |  Ties: ${ties}`);
  console.log(`  Total runs scored: ${totalFirstInningsRuns + totalSecondInningsRuns} in ${NUM_MATCHES * 2} innings`);

  // ── Diagnosis ─────────────────────────────────────────────────

  console.log(`\n${divider("=")}`);
  console.log("  DIAGNOSIS: Parameters likely causing any deviations");
  console.log(divider("="));

  const issues: string[] = [];

  if (avgFirstInnings < 165) {
    issues.push(
      "FIRST INNINGS TOO LOW: The base outcome probabilities in baseOutcomeProbabilities() " +
      "may have dot ball probability too high or boundary (4/6) probabilities too low. " +
      "Check the 'dot' base (~0.36) and '4'/'6' base values. Also check PHASE_MULTIPLIERS " +
      "for powerplay/death phase boundary boosts."
    );
  } else if (avgFirstInnings > 175) {
    issues.push(
      "FIRST INNINGS TOO HIGH: Boundary probabilities in baseOutcomeProbabilities() may be " +
      "inflated. Check '4' base (~0.12) and '6' base (~0.055). The PHASE_MULTIPLIERS death " +
      "overs six boost (1.25) may be too generous."
    );
  }

  if (avgSecondInnings > 165) {
    issues.push(
      "SECOND INNINGS TOO HIGH: The chaseAdjustment() function may not apply enough " +
      "wicket pressure when the required rate is high. Check the cappedPressure multiplier " +
      "for boundary inflation during chases."
    );
  } else if (avgSecondInnings < 155) {
    issues.push(
      "SECOND INNINGS TOO LOW: The chaseAdjustment() 'comfortable position' branch may " +
      "suppress scoring too much (increases dots/singles when ahead). Also check the " +
      "pace bowler 2nd innings bonus (probs.wicket *= 1.08) after over 10."
    );
  }

  if (batFirstWinPct > 50) {
    issues.push(
      "BAT-FIRST WINS TOO HIGH: The chaseAdjustment() function may not give enough " +
      "acceleration to chasers. Or the stadiumBowlRating/dewFactor settings may not " +
      "adequately help the 2nd innings team. Check the dew factor modifiers in matchups.ts."
    );
  } else if (batFirstWinPct < 45) {
    issues.push(
      "BAT-FIRST WINS TOO LOW: Chase context gives too much advantage. The " +
      "chaseAdjustment() 'need to accelerate' branch may boost boundaries too aggressively. " +
      "Or the 2nd innings ball-change pace bonus makes it too easy to chase."
    );
  }

  if (avgBatterSR < 135) {
    issues.push(
      "STRIKE RATE TOO LOW: Overall dot ball frequency is too high. " +
      "Check baseOutcomeProbabilities() dot base (0.36) and single base (0.28). " +
      "Also check PHASE_MULTIPLIERS middle overs dot boost (1.1) which slows middle overs."
    );
  } else if (avgBatterSR > 145) {
    issues.push(
      "STRIKE RATE TOO HIGH: Boundary rates are inflated. Check '4' and '6' " +
      "probabilities in baseOutcomeProbabilities(), and death-overs PHASE_MULTIPLIERS."
    );
  }

  if (avgBowlerEcon > 9.0) {
    issues.push(
      "BOWLING ECONOMY TOO HIGH: Bowlers are too expensive. Check if the " +
      "bowler economy/accuracy ratings are not suppressing enough. The wide probability " +
      "base (0.03) and noball (0.005) add ~4-5 extras per innings."
    );
  } else if (avgBowlerEcon < 8.0) {
    issues.push(
      "BOWLING ECONOMY TOO LOW: Bowlers are too effective. Stadium bowling ratings, " +
      "the pitch type modifiers in matchups.ts, or the bowler accuracy bonus on dots " +
      "may be too strong."
    );
  }

  if (avgFoursPerInnings < 12) {
    issues.push(
      "FOURS TOO LOW: The '4' probability base (~0.12) in baseOutcomeProbabilities() " +
      "or the timing bonus (+0.02) may be insufficient. Check PHASE_MULTIPLIERS for " +
      "powerplay fours boost (1.3)."
    );
  }

  if (avgSixesPerInnings < 5) {
    issues.push(
      "SIXES TOO LOW: The '6' probability base (~0.055) in baseOutcomeProbabilities() " +
      "or the power bonus (+0.025) may be insufficient. Check death overs six boost (1.25)."
    );
  } else if (avgSixesPerInnings > 9) {
    issues.push(
      "SIXES TOO HIGH: The '6' probability is inflated. Check base (0.055), " +
      "power bonus (0.025), and death-overs PHASE_MULTIPLIER (1.25). " +
      "Also check chaseAdjustment() six boost (1 + pressure * 0.3)."
    );
  }

  if (issues.length === 0) {
    console.log("\n  All stats are within real IPL ranges. The engine is well-calibrated!");
  } else {
    for (const issue of issues) {
      console.log(`\n  * ${issue}`);
    }
  }

  console.log(`\n${divider("=")}`);
}

main();
