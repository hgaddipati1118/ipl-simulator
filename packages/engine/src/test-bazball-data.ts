/**
 * England's batting from June 2022 ("Bazball") as the engine plays it (docs/COUNTRY-VALIDATION.md, "Test results by country").
 *
 * The ball model's Bazball factor (test-model-data.ts `bazball`) is fitted net of the fitted batter terms. The engine does not play
 * the fitted terms: it plays the rating maps' terms, and the maps read a batter's survival off battingIQ, the level attribute,
 * which England's batters carry from Test records made at the Bazball scoring rate. With the XIs that played, England's batters
 * outlasted the real ones by 12% of balls per wicket against their opponents in the same Tests (June 2022 to 2024). These
 * multipliers on top of the fitted factor close that, fitted on those Tests only (benchmark-test-countries.test.ts, England,
 * actual XIs); 2025+ is the holdout. `runs` scales the scoring classes (1, 2, 3, 4, 6), `wickets` the wicket class.
 * Mutable so the benchmark can try other values (BENCH_BAZCAL); the game never changes it.
 */
export const TEST_BAZBALL_CAL: { wickets: number; runs: number } = { wickets: 1.11, runs: 1 };
