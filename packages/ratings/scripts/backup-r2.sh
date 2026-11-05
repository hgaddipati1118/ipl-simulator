#!/usr/bin/env bash
# Back up scraped cricket data to Cloudflare R2 (bucket ipl-simulator-data, rclone remote "r2").
#
# The data/ dir is gitignored and was lost once (it lived only in ~/Documents), so every
# scraper stage should end with this. Uploads only what's new:
#   raw/cache/bundle-<UTC time>.tar.gz   HTML pages cached since the last run (CricketArchive)
#   raw/<path>.gz                        cumulative outputs (profiles, scorecards, ESPN, index), replaced each run
#   gz/<path>                            outputs already gzipped by the scraper, copied as-is
#   parquet/<table>.parquet              tables exported from data/cricket.db (if built)
# Cricsheet's 5GB of match JSON is skipped: it's public and re-downloadable (cricsheet-players.ts).
#
# Setup once: rclone config create r2 s3 provider=Cloudflare access_key_id=… secret_access_key=… endpoint=…
# Usage:   scripts/backup-r2.sh            # back up
#          scripts/backup-r2.sh restore    # pull everything back into data/

set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${R2_REMOTE:-r2}:${R2_BUCKET:-ipl-simulator-data}"
DATA=data
STATE="$DATA/.backup"
MANIFEST="$STATE/cache-uploaded.txt"
mkdir -p "$STATE"

# Already-compressed outputs, uploaded and restored byte for byte
GZIPPED=(
  scorecards/scorecards-events.jsonl.gz
)

# Cumulative files: small enough to re-upload whole each run
CUMULATIVE=(
  archive/profiles.jsonl
  scorecards/scorecards.jsonl
  scorecards/match-index.json
  scorecards/players-seen.json
  scorecards/discovery-progress.json
  scorecards/event-discovery-progress.json
  scraped/espn-players.json
  scraped/espn-player-index.json
  scraped/cricsheet-players.json
  scraped/matched-players.json
  scraped/player-stats.json
  scraped/scrape-progress.json
  index/player-index.json
  index/crawl-progress.json
  cricsheet/people.csv
)

restore() {
  mkdir -p "$DATA/cache"
  rclone copy "$REMOTE/raw" "$STATE/restore" --progress
  for f in "$STATE"/restore/cache/bundle-*.tar.gz; do
    [ -e "$f" ] && tar -xzf "$f" -C "$DATA/cache" && basename "$f" >> "$STATE/bundles-restored.txt"
  done
  (cd "$STATE/restore" && find . -name '*.gz' ! -path './cache/*') | while read -r gz; do
    out="$DATA/${gz#./}"; out="${out%.gz}"
    mkdir -p "$(dirname "$out")"
    gunzip -c "$STATE/restore/$gz" > "$out"
  done
  rclone copy "$REMOTE/gz" "$DATA" --progress
  ls "$DATA/cache" > "$MANIFEST"
  rm -rf "$STATE/restore"
  echo "Restored into $DATA/ (Cricsheet match files: re-run src/pipeline/cricsheet-players.ts)"
}

backup() {
  rclone mkdir "$REMOTE" 2>/dev/null || true

  # 1. New cached pages -> one compressed bundle
  touch "$MANIFEST"
  NEW="$STATE/cache-new.txt"
  if [ -d "$DATA/cache" ]; then
    comm -13 <(sort "$MANIFEST") <(ls "$DATA/cache" | sort) > "$NEW"
  else
    : > "$NEW"
  fi
  if [ -s "$NEW" ]; then
    bundle="bundle-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    tar -czf "$STATE/$bundle" -C "$DATA/cache" -T "$NEW"
    rclone copyto "$STATE/$bundle" "$REMOTE/raw/cache/$bundle"
    cat "$NEW" >> "$MANIFEST"
    echo "cache: $(wc -l < "$NEW" | tr -d ' ') new pages -> $bundle ($(du -h "$STATE/$bundle" | cut -f1))"
    rm "$STATE/$bundle"
  else
    echo "cache: nothing new"
  fi

  # 2. Cumulative outputs, gzipped
  for rel in "${CUMULATIVE[@]}"; do
    [ -f "$DATA/$rel" ] || continue
    gzip -c "$DATA/$rel" > "$STATE/upload.gz"
    rclone copyto "$STATE/upload.gz" "$REMOTE/raw/$rel.gz"
    echo "raw/$rel.gz ($(du -h "$STATE/upload.gz" | cut -f1))"
  done
  rm -f "$STATE/upload.gz"
  for rel in "${GZIPPED[@]}"; do
    [ -f "$DATA/$rel" ] || continue
    rclone copyto "$DATA/$rel" "$REMOTE/gz/$rel"
    echo "gz/$rel ($(du -h "$DATA/$rel" | cut -f1))"
  done

  # 3. Parquet tables from the query database
  if [ -f "$DATA/cricket.db" ] && command -v duckdb >/dev/null; then
    out="$STATE/parquet"; rm -rf "$out"; mkdir -p "$out"
    duckdb -c "INSTALL sqlite; LOAD sqlite; ATTACH '$DATA/cricket.db' AS c (TYPE sqlite, READ_ONLY);
      COPY c.players        TO '$out/players.parquet'        (FORMAT parquet, COMPRESSION zstd);
      COPY c.player_teams   TO '$out/player_teams.parquet'   (FORMAT parquet, COMPRESSION zstd);
      COPY c.player_careers TO '$out/player_careers.parquet' (FORMAT parquet, COMPRESSION zstd);
      COPY c.matches        TO '$out/matches.parquet'        (FORMAT parquet, COMPRESSION zstd);
      COPY c.batting        TO '$out/batting.parquet'        (FORMAT parquet, COMPRESSION zstd);
      COPY c.bowling        TO '$out/bowling.parquet'        (FORMAT parquet, COMPRESSION zstd);"
    rclone sync "$out" "$REMOTE/parquet"
    echo "parquet: $(ls "$out" | wc -l | tr -d ' ') tables ($(du -sh "$out" | cut -f1))"
    rm -rf "$out"
  fi

  # 4. Ratings-analysis tables (deliveries, player seasons, venue + league factors)
  if [ -d "$DATA/analysis" ]; then
    rclone sync "$DATA/analysis" "$REMOTE/analysis" --filter '+ *.parquet' --filter '+ *.csv' --filter '- *'
    echo "analysis: $(ls "$DATA/analysis" | grep -cE '\.(parquet|csv)$' | tr -d ' ') files"
  fi

  echo "Backed up to $REMOTE ($(rclone size "$REMOTE" 2>/dev/null | tail -1 | sed 's/^ *//'))"
}

case "${1:-backup}" in
  restore) restore ;;
  backup) backup ;;
  *) echo "usage: $0 [backup|restore]" >&2; exit 1 ;;
esac
