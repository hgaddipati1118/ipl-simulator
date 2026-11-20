/**
 * DRS review lines for a run out name the batter who is out, not the striker (live-match.ts): with a non-striker run out the
 * line says "<partner> was IN / short", the pending review is about the partner, and the run goes back to the striker.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyDecision, autoResolveDecision, createMatchState, simulateRemaining, startSecondInnings, stepBall, type MatchState } from "../live-match.js";
import { setRuleOverrides } from "../delivery-rules.js";
import { Player } from "../player.js";
import { RULE_PRESETS } from "../rules.js";
import { Team, IPL_TEAMS } from "../team.js";

const SURNAMES = ["Quillfeather", "Marbleton", "Zephyrov", "Oakhurst", "Tamarind", "Velkanov", "Dunmore", "Pellegrino", "Ashgrove", "Kestrelman", "Ulverton", "Brightwell"];
const FIRSTS = ["Zayan", "Torin", "Marlo", "Evander", "Lucan", "Yorick", "Casimir", "Ottoline", "Percival", "Dmitri", "Anselm", "Rafferty"];

function makeTeam(idx: number, tag: string): Team {
  const team = new Team({ ...IPL_TEAMS[idx] });
  const roles: ("batsman" | "all-rounder" | "bowler")[] = ["batsman", "batsman", "batsman", "batsman", "batsman", "all-rounder", "all-rounder", "all-rounder", "bowler", "bowler", "bowler", "bowler"];
  const styles = ["right-arm-fast", "off-spin", "left-arm-orthodox", "leg-spin", "right-arm-medium", "left-arm-fast"] as const;
  roles.forEach((role, i) => {
    const bat = role === "batsman";
    team.addPlayer(new Player({
      id: `${tag}_${i}`,
      name: `${FIRSTS[(i + idx) % FIRSTS.length]} ${SURNAMES[(i * 5 + idx) % SURNAMES.length]}`,
      age: 26, country: "India", role,
      ratings: { battingIQ: bat ? 70 : 45, timing: bat ? 68 : 40, power: bat ? 66 : 45, running: 55, wicketTaking: bat ? 20 : 66, economy: bat ? 20 : 64, accuracy: bat ? 20 : 62, clutch: 55 },
      battingHand: i % 3 === 0 ? "left" : "right",
      bowlingStyle: bat ? undefined : styles[i % styles.length],
      injured: false, injuryGamesLeft: 0, isInternational: false, isWicketKeeper: i === 4,
    }), 5);
  });
  return team;
}

const REVIEW_LINE = /DRS review/;

describe("DRS run out lines name the batter who is out", () => {
  afterEach(() => setRuleOverrides(null));

  it("CPU reviews of non-striker run outs say who was in / short", () => {
    setRuleOverrides({ forceKind: "run_out", forceRunOutRole: "nonStriker", forceRunOutRuns: 1 });
    let checked = 0, overturned = 0, stood = 0;
    for (let seed = 1; seed <= 24 && (overturned === 0 || stood === 0); seed++) {
      const { balls } = simulateRemaining(createMatchState(makeTeam(0, `h${seed}`), makeTeam(1, `a${seed}`), RULE_PRESETS.modern, null, seed));
      for (const b of balls) {
        if (!REVIEW_LINE.test(b.commentary) || !/was (IN|short)/.test(b.commentary)) continue;
        checked++;
        // overturned lines no longer have a wicket: the batter who was reviewed is named in the line itself
        const m = b.commentary.match(/[.!] ([^.!]+?) was (IN|short)\./);
        expect(m, b.commentary).not.toBeNull();
        expect(m![1]).not.toBe("Batter");
        if (m![2] === "IN") overturned++; else stood++;
        // the striker (batterName) is never the one reviewed: the partner is
        if (m![2] === "short") expect(b.playerOutName).toBe(m![1]);
        if (m![2] === "short") expect(m![1]).not.toBe(b.batterName);
        expect(b.commentary).not.toMatch(/Batter was/);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(overturned).toBeGreaterThan(0);
    expect(stood).toBeGreaterThan(0);
  });

  it("a user's review of a non-striker run out is about the partner, and the result line names him", () => {
    setRuleOverrides({ forceKind: "run_out", forceRunOutRole: "nonStriker", forceRunOutRuns: 1 });
    let asked = 0, named = 0;
    for (let seed = 1; seed <= 30 && named < 2; seed++) {
      const a = makeTeam(0, `uh${seed}`), b = makeTeam(1, `ua${seed}`);
      let st: MatchState = createMatchState(a, b, RULE_PRESETS.modern, a.id, seed);
      for (let k = 0; k < 2000 && st.status !== "completed"; k++) {
        if (st.status === "waiting_for_decision") {
          const p = st.pendingDecision!;
          if (p.type === "drs_review" && p.drsContext?.reviewKind === "runout") {
            asked++;
            const last = st.ballLog[st.ballLog.length - 1];
            expect(p.drsContext.batterName).toBe(last.playerOutName);
            expect(p.drsContext.batterName).not.toBe(last.batterName);
            const next = applyDecision(st, { type: "drs_review", selectedPlayerId: "review" });
            const line = next.ballLog[next.ballLog.length - 1].commentary;
            expect(line).toContain(`${p.drsContext.batterName} was`);
            expect(line).not.toMatch(/Batter was/);
            named++;
            st = next;
            continue;
          }
          st = autoResolveDecision(st);
          continue;
        }
        if (st.status === "innings_break") { st = startSecondInnings(st); continue; }
        st = stepBall(st).state;
      }
    }
    expect(asked).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
  });
});
