// Placeholder until packages/mods exists: regenerate with `npm run context`.
// Describes SDK v1 as specified in docs/MODS-DESIGN.md.
export const SDK_VERSION = "1";
export const SDK_TYPES = `
export type BallOutcome = "dot" | "1" | "2" | "3" | "4" | "6" | "wicket" | "wide" | "noball";
export type BallProbabilities = Record<BallOutcome, number>;

export interface PlayerView {
  id: string; name: string; role: "batsman" | "bowler" | "all-rounder" | "wicket-keeper";
  battingHand: "left" | "right"; bowlingStyle?: string; isPace: boolean; isSpin: boolean;
  ratings: Record<string, number>;
}
export interface VenueView { id: string; name: string; pitchType: string; boundarySize: string; dewFactor: string; }
export interface BallContext {
  batter: PlayerView; bowler: PlayerView; over: number; ball: number; innings: 1 | 2;
  score: number; wickets: number; target?: number; ballsRemaining: number;
  phase: "powerplay" | "middle" | "death"; venue: VenueView; rng: () => number;
}

export interface ModDefinition {
  data?: { players?(players: PlayerView[]): PlayerView[]; teams?(teams: unknown[]): unknown[] };
  rules?(rules: Record<string, unknown>): Record<string, unknown>;
  engine?: {
    ballProbabilities?(ctx: BallContext, probs: BallProbabilities): BallProbabilities;
    onBall?(ctx: BallContext, event: { outcome: BallOutcome; runs: number }): void;
    matchFormat?(format: { overs: number; powerplayOvers: number }): { overs: number; powerplayOvers: number };
  };
  ui?: { theme?: Record<string, string> };
  commentary?: { line?(event: unknown, ctx: BallContext): string | null };
}
export function defineMod(mod: ModDefinition): ModDefinition;
`;
export const EXAMPLE_MODS: string[] = [
  `// spin-friendly-chepauk/manifest.json
{ "id": "spin-friendly-chepauk", "name": "Spin-friendly Chepauk", "version": "1.0.0", "sdk": "1",
  "hooks": ["engine.ballProbabilities"], "description": "Spinners take more wickets and bowl more dots in Chennai." }

// spin-friendly-chepauk/mod.js
import { defineMod } from "@ipl-sim/mods";
export default defineMod({
  engine: {
    ballProbabilities(ctx, probs) {
      if (ctx.venue.id !== "chepauk" || !ctx.bowler.isSpin) return probs;
      return { ...probs, wicket: probs.wicket * 1.15, dot: probs.dot * 1.08 };
    },
  },
});`,
];
