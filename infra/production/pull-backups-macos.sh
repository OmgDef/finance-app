#!/bin/sh
set -eu
umask 077

destination=$1
server=$2
mkdir -p "$destination"
/usr/bin/rsync -rt --timeout=60 --exclude='.*' \
    -e '/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ConnectTimeout=10' \
    "$server:/opt/tetafinance/backups/" "$destination/"

last=
for backup in "$destination"/????????T??????Z; do
    [ -f "$backup/SHA256SUMS" ] && last=$backup
done
if [ -z "$last" ]; then
    printf '%s\n' 'No complete TetaFinance backup received' >&2
    exit 1
fi
(cd "$last" && /usr/bin/shasum -a 256 -c SHA256SUMS)
if [ -z "$(/usr/bin/find "$last/teta.sql.gpg" -mmin -900 -print)" ]; then
    printf '%s\n' "TetaFinance backup is more than 15 hours old: $last" >&2
    exit 1
fi
