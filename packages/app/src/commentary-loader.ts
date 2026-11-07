import { hasCommentaryModel, loadCommentaryModel } from "@ipl-sim/engine";

/** The generated real-commentary model (docs/COMMENTARY.md). */
export const COMMENTARY_MODEL_URL = "/data/commentary-model.json";

let pending: Promise<boolean> | null = null;

/**
 * Load the commentary model once (the idle preload in main.tsx and any page that needs it share one fetch).
 * Resolves true when the model is available; a failed fetch can be retried by a later call.
 */
export function ensureCommentaryModel(): Promise<boolean> {
  if (hasCommentaryModel()) return Promise.resolve(true);
  if (!pending) {
    pending = loadCommentaryModel(COMMENTARY_MODEL_URL).then(ok => {
      if (!ok) pending = null;
      return ok;
    });
  }
  return pending;
}
