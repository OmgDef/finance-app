#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ $# == 5 ]] || fail 'Usage: recovery-backup.sh {dump|restore} MYSQL_CNF SCHEMA PASSPHRASE_FILE ARTIFACT.gpg'
action=$1 options=$2 schema=$3 key=$4 artifact=$5
[[ $schema =~ ^[a-zA-Z0-9_]{1,64}$ && -r $options && -s $key && $artifact == *.gpg ]] ||
  fail 'Expected a schema name, readable MySQL and passphrase files, and a .gpg artifact path.'

mysql_client=(mysql "--defaults-file=$options" --batch --skip-column-names)
temporary=''
trap 'if [[ -n $temporary ]]; then rm -rf -- "$temporary"; fi' EXIT

configure_gpg() {
  mkdir -- "$temporary/gnupg"
  gpg_client=(gpg --no-options --homedir "$temporary/gnupg" --batch --yes --no-symkey-cache \
    --pinentry-mode loopback --passphrase-file "$key")
}

case $action in
  dump)
    [[ ! -e $artifact && ! -e $artifact.sha256 ]] || fail 'Choose a new artifact path.'
    engine_count=$("${mysql_client[@]}" --database="$schema" --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND engine <> 'InnoDB'")
    [[ $engine_count == 0 ]] || fail 'A consistent dump requires all base tables to use InnoDB.'
    temporary=$(mktemp -d -- "$(dirname -- "$artifact")/.teta-backup.XXXXXX")
    configure_gpg
    snapshot=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
    mysqldump "--defaults-file=$options" --single-transaction --quick --no-tablespaces \
      --set-gtid-purged=OFF --hex-blob --skip-dump-date --skip-add-drop-table "$schema" |
      "${gpg_client[@]}" --symmetric --cipher-algo AES256 --output "$temporary/artifact.gpg"
    "${gpg_client[@]}" --decrypt "$temporary/artifact.gpg" >/dev/null
    checksum=$(sha256sum -- "$temporary/artifact.gpg")
    printf '%s\n' "${checksum%% *}" > "$temporary/artifact.sha256"
    ln -- "$temporary/artifact.gpg" "$artifact"
    ln -- "$temporary/artifact.sha256" "$artifact.sha256"
    printf '%s\n' "$snapshot"
    ;;
  restore)
    table_count=$("${mysql_client[@]}" --database="$schema" --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()")
    [[ $table_count == 0 ]] || fail 'Create a separate empty target schema before restoring.'
    temporary=$(mktemp -d)
    configure_gpg
    cp -- "$artifact" "$temporary/artifact.gpg"
    read -r checksum < "$artifact.sha256"
    [[ $checksum =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid backup checksum.'
    printf '%s  %s\n' "$checksum" "$temporary/artifact.gpg" | sha256sum --check --status
    "${gpg_client[@]}" --decrypt "$temporary/artifact.gpg" >/dev/null
    "${gpg_client[@]}" --decrypt "$temporary/artifact.gpg" | "${mysql_client[@]}" --database="$schema"
    ;;
  *) fail 'Expected dump or restore.' ;;
esac
