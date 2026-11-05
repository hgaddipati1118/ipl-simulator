#!/usr/bin/env bash
# Resume every scraper: ESPN profiles in parallel with the CricketArchive chain, plus hourly R2 backups.
cd "$(dirname "$0")/.."
L=data/scraped
nohup npx tsx src/pipeline/espn-scraper.ts --skip-index --resume --concurrency 2 >> $L/espn-scrape.log 2>&1 &
nohup bash -c '
  set -x
  npx tsx src/pipeline/archive-profiles.ts
  npx tsx src/pipeline/run.ts --step index --resume
  npx tsx src/pipeline/cricsheet-players.ts
  npx tsx src/pipeline/archive-profiles.ts
  npx tsx src/pipeline/run.ts --step scrape --resume
  npx tsx src/pipeline/scorecards.ts --no-events
  npx tsx src/pipeline/archive-profiles.ts
  npx tsx src/pipeline/scorecards.ts --step discover-events
  npx tsx src/pipeline/scorecards.ts --step scrape
  npx tsx src/pipeline/archive-profiles.ts
  scripts/backup-r2.sh
' >> $L/cricketarchive-pipeline.log 2>&1 &
nohup bash -c 'while pgrep -f "src/pipeline/(espn-scraper|archive-profiles|run|scorecards|cricsheet-players)\.ts" >/dev/null; do sleep 3600; scripts/backup-r2.sh; done' >> $L/backup-loop.log 2>&1 &
