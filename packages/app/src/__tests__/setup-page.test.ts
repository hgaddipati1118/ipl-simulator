import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { EXTRA_LEAGUES, RULE_PRESETS, type RuleSet } from "@ipl-sim/engine";
import { SetupPage } from "../pages/SetupPage";
import { createGameState } from "../game-state";

/** Server-render the Setup page for each league (no browser): the league can be picked and its teams are listed. */
function render(rules: RuleSet) {
  const state = createGameState(rules);
  return renderToString(
    createElement(MemoryRouter, null,
      createElement(SetupPage, { teams: state.teams, rules, onRulesChange: () => {}, onSelectTeam: () => {} })),
  ).replace(/<!-- -->/g, ""); // React's text-node separators
}

describe("Setup page league picker", () => {
  it("offers every extra league", () => {
    const html = render(RULE_PRESETS.modern2026);
    for (const l of EXTRA_LEAGUES) expect(html).toContain(`data-testid="league-${l.id}"`);
  });

  it.each(EXTRA_LEAGUES.map(l => [l.id, l] as const))("%s: shows the league's name, teams and rules", (_id, league) => {
    const html = render(league.rules);
    expect(html).toContain(`${league.short}</span>`);
    expect(html).toContain(`${league.teams.length} teams`);
    for (const t of league.teams) expect(html).toContain(t.name.replace(/'/g, "&#x27;"));
    expect(html).toContain(`OS in XI: <span class="text-th-secondary">${league.rules.maxOverseasInXI}</span>`);
    if (league.rules.matchFormat === "hundred") expect(html).toContain("100-ball innings");
    else expect(html).not.toContain("100-ball innings");
  });
});
