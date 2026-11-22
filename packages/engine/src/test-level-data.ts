/**
 * The men's Test level as the engine plays it (docs/FORMATS.md, Test section 6.12).
 *
 * The men's base rates in test-model-data.ts carry the round-2 level (`LEVEL` in test-match-model.py: wickets x1.06, scoring
 * x0.97), set when balls per wicket and runs per over matched real Tests since 2023. The ratings and captaincy that came after
 * (five-fors, the rebuilt pool's Test sets, the two-source batting prior, South Africa's bowling term, Bazball on mapped terms)
 * took wickets faster. These multipliers on top of the base close that, fitted on the men's Tests of 2023-24 with the XIs that
 * played (benchmark-test-countries.test.ts); 2025+ is the holdout. `wickets` scales the wicket class, `runs` the scoring
 * classes (1, 2, 3, 4, 6). Men only: the women's base is levelled on their own squads. Mutable so the benchmarks can try other
 * values (TEST_LEVEL / BENCH_LEVEL); the game never changes it.
 */
export const TEST_LEVEL_CAL: { wickets: number; runs: number } = { wickets: 1, runs: 1 };
