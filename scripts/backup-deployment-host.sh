#!/usr/bin/env bash
set -euo pipefail
ssh -o BatchMode=yes deployment-host bash -s <<'REMOTE'
set -euo pipefail
umask 077
backup_directory="/home/user/.config/studio-tv/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_directory"
docker exec studio-tv-db-1 pg_dump -U rhtv -d rhtv -Fc > "$backup_directory/database.dump"
docker exec studio-tv-api-1 tar -C /data/assets -czf - . > "$backup_directory/assets.tar.gz"
character_repository=/home/user/apps/studio-tv
character_cache="$character_repository/.local/catalog/studio-character-media"
if [ -d "$character_cache" ]; then
  character_verifier="$character_repository/scripts/import-character-media.py"
  character_manifest="$character_repository/apps/api-go/internal/modules/resources/adapters/postgres/seed/character-media.json"
  # The first release can stage the independently verified cache before the
  # installed checkout contains its importer. Preserve that cache in preflight backup.
  if [ ! -f "$character_verifier" ]; then
    character_verifier="$character_repository/.local/catalog/import-character-media.py"
    character_manifest="$character_repository/.local/catalog/character-media.json"
  fi
  python3 "$character_verifier" --verify --manifest "$character_manifest" --cache "$character_cache"
  tar -C "$character_cache" -czf "$backup_directory/character-media.tar.gz" .
  cp "$character_manifest" "$backup_directory/character-media-manifest.json"
fi
cp /home/user/.config/studio-tv/server.env "$backup_directory/server.env"
git -C /home/user/apps/studio-tv rev-parse HEAD > "$backup_directory/revision.txt"
test -s "$backup_directory/database.dump"
test -s "$backup_directory/assets.tar.gz"
printf 'Backup saved: %s\n' "$backup_directory"
REMOTE
