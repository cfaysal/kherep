#!/usr/bin/env bash
# Retirement pass for bootstrap/install.sh (OP-1136). Source me; do not execute.
#
# Reads bootstrap/manifest/retired.txt and hands every declared live path to
# transaction_retire_path, so a file the repo no longer manages is parked in a
# _deprecated/ sibling instead of surviving unmanaged and unwired. Own file so
# install.sh stays a readable sequence of phases rather than growing a loop.
#
# An entry is relative to the Claude home, unless it carries the project/ prefix
# that install.sh and drift-check.sh already use for workspace files: those map
# to the workspace (#33). Both kinds are parked the same way, inside the same
# transaction, with their backup under retired/<entry> in the install backup.

# Prints the live path a validated retirement entry names. drift-check.sh uses
# the same mapping, so an entry the installer parks is the entry it reports.
bootstrap_retired_live_path() {
  local rel="$1" home="$2" ws="$3"
  case "$rel" in
    project/*) printf '%s\n' "$ws/${rel#project/}" ;;
    *) printf '%s\n' "$home/$rel" ;;
  esac
}

bootstrap_retire_declared() {
  local manifest="$1" home="$2" ws="$3" backup="$4" rel live
  [ -f "$manifest" ] || { echo "FATAL: retirement manifest missing: $manifest" >&2; return 1; }
  while IFS= read -r rel || [ -n "$rel" ]; do
    rel="${rel%$'\r'}"
    case "$rel" in ''|'#'*) continue ;; esac
    kherep_validate_manifest_relative_path "retirement manifest entry" "$rel" || return $?
    live="$(bootstrap_retired_live_path "$rel" "$home" "$ws")"
    transaction_retire_path "$rel" "$live" "$backup/retired/$rel" || return $?
  done < "$manifest"
}
