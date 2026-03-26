export type DrsVerdict = "overturned" | "umpires-call" | "review-lost";

export function isDrsCommentary(commentary?: string | null): boolean {
  return typeof commentary === "string" && commentary.toUpperCase().includes("DRS REVIEW");
}

export function getDrsVerdict(commentary?: string | null): DrsVerdict | null {
  if (typeof commentary !== "string" || !isDrsCommentary(commentary)) return null;
  const normalized = commentary.toUpperCase();
  if (normalized.includes("OVERTURNED")) return "overturned";
  if (normalized.includes("UMPIRE'S CALL")) return "umpires-call";
  if (normalized.includes("LOSE THEIR REVIEW") || normalized.includes("CLEARLY MISSING")) return "review-lost";
  return "review-lost";
}

export function getDrsVerdictLabel(verdict: DrsVerdict, commentary?: string | null): string {
  const normalized = typeof commentary === "string" ? commentary.toUpperCase() : "";

  switch (verdict) {
    case "overturned":
      if (
        normalized.includes("THAT'S OUT") ||
        normalized.includes(" LBW!") ||
        normalized.includes("BATTER IS OUT")
      ) {
        return "DRS OUT";
      }
      return "CALL OVERTURNED";
    case "umpires-call":
      return "UMPIRE'S CALL";
    case "review-lost":
      return "REVIEW LOST";
  }
}
