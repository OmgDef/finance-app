#!/usr/bin/env bash
set -euo pipefail
umask 077

cd /opt/tetafinance
exec 9>private/maintenance.lock
flock -w 300 9

stamp=$(date -u +%Y%m%dT%H%M%SZ)
staging=$(mktemp -d backups/.incomplete.XXXXXX)
trap 'rm -rf -- "$staging"' EXIT
mkdir "$staging/gnupg"
gpg_options=(--no-options --homedir "$staging/gnupg" --batch --no-symkey-cache
  --pinentry-mode loopback --passphrase-file private/backup-passphrase)

docker compose exec -T db sh -eu -c '
  export MYSQL_PWD="$MYSQL_PASSWORD"
  exec mysqldump --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF +    --hex-blob --skip-dump-date --skip-add-drop-table -u "$MYSQL_USER" "$MYSQL_DATABASE"
' | gpg "${gpg_options[@]}" --symmetric --cipher-algo AES256 --output "$staging/teta.sql.gpg"
gpg "${gpg_options[@]}" --decrypt "$staging/teta.sql.gpg" >/dev/null
rm -r -- "$staging/gnupg"
(cd "$staging" && sha256sum teta.sql.gpg > SHA256SUMS)
mv -T -- "$staging" "backups/$stamp"

find backups -mindepth 2 -maxdepth 2 -type f \( -name teta.sql.gpg -o -name SHA256SUMS \) -mtime +14 -delete
find backups -mindepth 1 -maxdepth 1 -type d -empty -delete
printf 'Verified TetaFinance backup %s\n' "$stamp"
