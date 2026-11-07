#!/bin/bash
# Pull the scraped Cricinfo commentary from oldmac into packages/ratings/data/commentary/ (gitignored).
# One-off:   packages/ratings/src/analysis/commentary-sync.sh
# Periodic:  packages/ratings/src/analysis/commentary-sync.sh loop 1800   (every 30 min; stop with Ctrl-C / kill)
set -u
DEST="${COMMENTARY_DATA:-$HOME/Developer/ipl-simulator/packages/ratings/data/commentary}"
SRC="oldmac:/Volumes/Data/Developer/cricinfo-commentary"
mkdir -p "$DEST/_scraper"
sync_once() {
  rsync -az --partial "$SRC/out/comm/" "$DEST/" --include='*.jsonl.gz' --exclude='*' \
    && rsync -az "$SRC/out/state.json" "$SRC/out/progress.json" "$SRC/out/series_index.json" "$SRC/logs/scraper.log" "$DEST/_scraper/" \
    && echo "$(date '+%F %T') synced: $(ls "$DEST"/*.jsonl.gz 2>/dev/null | grep -v balls.jsonl.gz | wc -l | tr -d ' ') files"
}
if [ "${1:-}" = "loop" ]; then
  while true; do sync_once || echo "$(date '+%F %T') sync failed"; sleep "${2:-1800}"; done
else
  sync_once
fi
