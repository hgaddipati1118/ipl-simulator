#!/usr/bin/env bash
# Resume the CricketArchive side after a stop (e.g. the login expired): top-level scorecards,
# then every competition's scorecards, then profiles for newly seen players, then an R2 backup.
# Each step skips what's already saved.
cd "$(dirname "$0")/.."
# Two copies double the load (which triggers CricketArchive's paywall block) and append duplicate cards
if pgrep -f "src/pipeline/(scorecards|archive-profiles|run)\.ts" >/dev/null; then
  echo "A CricketArchive step is already running; not starting another." >&2
  exit 1
fi
nohup bash -c '
  set -ex
  npx tsx src/pipeline/scorecards.ts --step scrape --no-events
  npx tsx src/pipeline/archive-profiles.ts
  npx tsx src/pipeline/scorecards.ts --step discover-events
  npx tsx src/pipeline/scorecards.ts --step scrape
  npx tsx src/pipeline/archive-profiles.ts
  scripts/backup-r2.sh
' >> data/scraped/cricketarchive-pipeline.log 2>&1 &
echo "CricketArchive pipeline resumed (log: data/scraped/cricketarchive-pipeline.log)"
