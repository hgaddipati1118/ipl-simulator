#!/usr/bin/env bash
# Wait until the browser-harness daemon can reach Chrome, then resume the CricketArchive pipeline
# and the ESPN team crawl (followed by a --model ratings regeneration, rebuild and tests).
cd "$(dirname "$0")/.."
until BU_NAME=ipl-scraper timeout 60 browser-harness <<<'print(len(cdp("Target.getTargets")["targetInfos"]))' >/dev/null 2>&1; do
  sleep 60
done
echo "$(date) Chrome connection is back; resuming scrapers"
scripts/resume-archive.sh
nohup bash -c '
  set -x
  npx tsx src/pipeline/espn-scraper.ts --resume --concurrency 2
  npx tsx src/pipeline/generate-ratings-espn.ts --model
  cd ../.. && npm run build --workspace=packages/ratings && npx vitest run 2>&1 | tail -40
' >> data/scraped/espn-followup.log 2>&1 &
echo "ESPN crawl resumed (log: data/scraped/espn-followup.log)"
