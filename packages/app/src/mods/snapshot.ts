import type { ModGameSnapshot } from "@ipl-sim/mods";
import type { GameState } from "../game-state";

/** The read-only view of the game that sandboxed mod UI receives. Plain data only, no engine objects. */
export function buildSnapshot(state: GameState | null): ModGameSnapshot {
  return {
    seasonNumber: state?.seasonNumber ?? 1,
    phase: state?.phase ?? "setup",
    userTeamId: state?.userTeamId ?? null,
    rulesName: state?.rules.name ?? "",
    teams: (state?.teams ?? []).map(t => ({
      id: t.id, name: t.name, shortName: t.shortName,
      wins: t.wins, losses: t.losses, points: t.points, nrr: Math.round(t.nrr * 1000) / 1000,
    })),
  };
}

/** Wrap mod HTML so the frame cannot load or send anything over the network (scripts and inline styles only). */
export function frameDocument(html: string): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  return `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${csp}">${html.replace(/^\s*<!doctype[^>]*>/i, "")}`;
}

/** Routes a mod may ask the app to navigate to: in-app absolute paths only. */
export function isSafeRoute(to: unknown): to is string {
  return typeof to === "string" && to.length < 200 && /^\/(?!\/)[\w\-./]*$/.test(to);
}
