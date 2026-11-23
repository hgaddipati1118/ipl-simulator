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
export const TEST_LEVEL_CAL: { wickets: number; runs: number } = { wickets: 0.96, runs: 0.99 };

/**
 * The men's Test match form (docs/FORMATS.md, Test section 6.13): each side draws its own strength for the match, z ~ N(0, sd),
 * from its own seeded stream, so nothing else in the match changes. While it bats its wicket rate is x exp(-z_bat + z_bowl - sd^2)
 * (mean 1 over matches). The rating-mapped sides are a little too predictable: with the XIs that played, the real margin
 * (log runs per wicket, one side over the other) sat 1.3x as far from the sim's mean as the sim's own replays did. Fitted on
 * the men's Tests of 2023-24; 2025+ held out. Men only; 0 turns it off. Mutable so the benchmarks can try values (TEST_FORM /
 * BENCH_FORM); the game never changes it.
 */
export const TEST_FORM: { sd: number } = { sd: 0.1 };
