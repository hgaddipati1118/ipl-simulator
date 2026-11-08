/**
 * Ball-by-ball commentary for a Test, newest first: each delivery's line (written by the engine from the commentary model,
 * built-in lines as the fallback), with the day / session / weather / new ball / declaration / nightwatchman markers and an
 * innings heading where each began.
 */

import { useState } from "react";
import type { TestMatchEvent, TestMatchState } from "@ipl-sim/engine";
import { ballChip, buildFeed, playerName } from "./test-view";
import { BallChip } from "./TestScoreboard";

const EVENT_STYLE: Partial<Record<TestMatchEvent["kind"], string>> = {
  stumps: "border-indigo-500/30 bg-indigo-500/5 text-indigo-300",
  day_start: "border-indigo-500/30 bg-indigo-500/5 text-indigo-300",
  lunch: "border-th bg-th-body text-th-secondary",
  tea: "border-th bg-th-body text-th-secondary",
  weather: "border-blue-500/30 bg-blue-500/10 text-blue-300",
  declaration: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  follow_on: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  new_ball: "border-red-500/30 bg-red-500/5 text-red-300",
  nightwatchman: "border-sky-500/30 bg-sky-500/5 text-sky-300",
  innings_end: "border-th bg-th-body text-th-primary",
  result: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  toss: "border-th bg-th-body text-th-secondary",
};

export function TestCommentary({ st }: { st: TestMatchState }) {
  const [limit, setLimit] = useState(120);
  const feed = buildFeed(st, limit);
  const balls = st.innings.reduce((a, i) => a + i.ballLog.length, 0);
  return (
    <div className="space-y-1.5" data-testid="test-commentary">
      {feed.length === 0 && <div className="text-sm text-th-muted font-display px-1 py-4">No balls bowled yet.</div>}
      {feed.map(item => {
        if (item.kind === "innings") {
          return (
            <div key={item.key} className="pt-3 pb-1 text-[11px] uppercase tracking-widest font-display font-bold text-th-muted">
              {item.text}
            </div>
          );
        }
        if (item.kind === "event") {
          return (
            <div key={item.key} className={`px-3 py-2 rounded-lg border text-xs font-display ${EVENT_STYLE[item.event.kind] ?? "border-th bg-th-body text-th-secondary"}`}>
              {item.event.text}
            </div>
          );
        }
        const c = ballChip(item.ev);
        const big = c.kind === "wicket" || c.kind === "four" || c.kind === "six";
        return (
          <div key={item.key} className={`flex gap-3 items-start px-3 py-2 rounded-lg ${big ? "bg-th-raised border border-th" : ""}`} data-testid="test-ball">
            <span className="text-[11px] font-mono text-th-faint w-10 shrink-0 pt-0.5">{item.label}</span>
            <BallChip label={c.label} kind={c.kind} />
            <div className="flex-1 min-w-0 text-sm text-th-secondary leading-snug">
              {item.ev.commentary ?? `${playerName(st, item.ev.bowler)} to ${playerName(st, item.ev.batter)}`}
              {item.ev.review && (
                <span className={`ml-2 text-[10px] font-display font-semibold uppercase ${item.ev.review.result === "overturned" ? "text-emerald-400" : item.ev.review.result === "umpires_call" ? "text-amber-400" : "text-red-400"}`}>
                  DRS: {item.ev.review.result.replace("_", "'s ")}
                </span>
              )}
            </div>
            <span className="text-[11px] font-mono text-th-muted shrink-0 pt-0.5">{item.ev.score}/{item.ev.wickets}</span>
          </div>
        );
      })}
      {feed.filter(f => f.kind === "ball").length < balls && (
        <button onClick={() => setLimit(l => l + 300)} className="w-full mt-2 px-4 py-2 text-xs font-display text-th-muted border border-th rounded-lg hover:bg-th-hover">
          Show earlier deliveries
        </button>
      )}
    </div>
  );
}
