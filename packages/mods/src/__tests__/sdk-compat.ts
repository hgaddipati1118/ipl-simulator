/**
 * Compile-time checks (npm run typecheck): the standalone SDK types must stay
 * mutually assignable with the engine types they mirror. A failing line here means
 * the engine changed under the SDK and sdk.ts needs a deliberate update.
 */
import type {
  BallContext, BallEvent, BallPlayer, BallProbabilities, BallVenue, MatchFormat, ModRuleSet, ModTeam, ModPlayer, ModPlayerRatings,
} from "../sdk.js";
import type {
  BallHookContext, BallHookEvent, BallProbabilities as EngineProbs, HookPlayer, HookVenue, MatchFormat as EngineFormat,
  RuleSet, TeamConfig, PlayerData, PlayerRatings,
} from "../../../engine/src/index.js";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertTrue<_T extends true>(): void {}

assertTrue<Mutual<BallContext, BallHookContext>>();
assertTrue<Mutual<BallEvent, BallHookEvent>>();
assertTrue<Mutual<BallPlayer, HookPlayer>>();
assertTrue<Mutual<BallVenue, HookVenue>>();
assertTrue<Mutual<BallProbabilities, EngineProbs>>();
assertTrue<Mutual<MatchFormat, EngineFormat>>();
assertTrue<Mutual<ModRuleSet, RuleSet>>();
assertTrue<Mutual<ModPlayerRatings, PlayerRatings>>();
// Data shapes are open (index signatures); plain copies of the engine types must be assignable into them
type Plain<T> = { [K in keyof T]: T[K] };
assertTrue<[Plain<TeamConfig>] extends [ModTeam] ? true : false>();
assertTrue<[Plain<Pick<PlayerData, "id" | "name" | "age" | "country" | "role" | "ratings" | "isInternational">>] extends [ModPlayer] ? true : false>();
