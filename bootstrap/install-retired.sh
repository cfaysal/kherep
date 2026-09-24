#!/usr/bin/env bash
# Retirement pass for bootstrap/install.sh (OP-1136). Source me; do not execute.
#
# Reads bootstrap/manifest/retired.txt and hands every declared live path to
# transaction_retire_path, so a file the repo no longer manages is parked in a
# _deprecated/ sibling instead of surviving unmanaged and unwired. Own file so
# install.sh stays a readable sequence of phases rather than growing a loop.
bootstrap_retire_declared() {
  local manifest="$1" home="$2" backup="$3" rel
  [ -f "$manifest" ] || { echo "FATAL: retirement manifest missing: $manifest" >&2; return 1; }
  while IFS= read -r rel || [ -n "$rel" ]; do
    rel="${rel%$'\r'}"
    case "$rel" in ''|'#'*) continue ;; esac
    kherep_validate_manifest_relative_path "retirement manifest entry" "$rel" || return $?
    transaction_retire_path "$rel" "$home/$rel" "$backup/retired/$rel" || return $?
  done < "$manifest"
}
