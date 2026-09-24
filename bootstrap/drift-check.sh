#!/usr/bin/env bash
# Reports drift between the repo's claude/ source and the live ~/.claude install. For every entry
# in bootstrap/manifest/files.txt it compares the repo version against the live file, applying the
# same machine-path -> ~ rewrite that install does (so a portable_paths rewrite is not false drift).
# Catches the bug class where a repo file is empty/stale while the live box has the working version
# (or vice versa) - exactly the manifest-watch / loc-watch / commit-guard divergence that bit us.
# Read-only. Exit 0 = in sync, exit 1 = drift or missing found.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/profile.sh"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
WS="$(kherep_env WORKSPACE "$(kherep_default_workspace)")"
CREDENTIALS_ROOT="$(kherep_env CREDENTIALS_ROOT "$(kherep_default_credentials_root)")"
INSTALL_ATLASSIAN_TOOLS="${KHEREP_INSTALL_ATLASSIAN_TOOLS:-0}"
kherep_validate_shell_path CLAUDE_HOME "$CLAUDE_HOME" || exit $?
kherep_validate_shell_path KHEREP_WORKSPACE "$WS" || exit $?
kherep_validate_shell_path KHEREP_CREDENTIALS_ROOT "$CREDENTIALS_ROOT" || exit $?
CLAUDE_SRC="$(cd "$HERE/.." && pwd)/claude"
MANIFEST="$HERE/manifest/files.txt"
DRIFT_SCOPE="${DRIFT_SCOPE:-all}"
[ "$DRIFT_SCOPE" = "all" ] || [ "$DRIFT_SCOPE" = "project" ] || {
  echo "FATAL: DRIFT_SCOPE must be all or project"; exit 2
}
if [ -x /usr/bin/find ]; then FIND_BIN=/usr/bin/find; else FIND_BIN="$(command -v find || true)"; fi
[ -n "$FIND_BIN" ] || { echo "FATAL: POSIX find required"; exit 2; }
command -v node >/dev/null || { echo "FATAL: node required"; exit 2; }

# Leave the result behind for claude/hooks/drift-check-nudge.js. The body writes
# a sibling temp file and atomically renames it only after the terminal marker,
# so readers keep seeing the previous complete report during a run. The report
# is replayed to real stdout, preserving interactive output and exit semantics.
# An unwritable cache simply means no report, never a failed run.
REPORT=""
REPORT_TMP=""
REPORT_DIR="$CLAUDE_HOME/.cache/drift-check"
if [ -d "$REPORT_DIR" ] || mkdir -p "$REPORT_DIR" 2>/dev/null; then
  REPORT="$REPORT_DIR/last-report.txt"
  REPORT_TMP="$(mktemp "$REPORT_DIR/.last-report.XXXXXX" 2>/dev/null || true)"
  if [ -n "$REPORT_TMP" ]; then
    exec 3>&1
    exec 1>"$REPORT_TMP"
  fi
fi

EXPECTED_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$EXPECTED_DIR"
  [ -z "$REPORT_TMP" ] || rm -f "$REPORT_TMP"
}
trap cleanup EXIT
node "$HERE/render-profile.mts" settings \
  "$KHEREP_PROFILE" "$WS" "$CREDENTIALS_ROOT" "$CLAUDE_HOME" \
  "$CLAUDE_SRC/settings.user.json" "$CLAUDE_SRC/settings.project.json" \
  "$CLAUDE_HOME/settings.json" "$WS/.claude/settings.local.json" \
  "$EXPECTED_DIR/settings.json" "$EXPECTED_DIR/settings.local.json"
node "$HERE/render-profile.mts" local-inference "$KHEREP_PROFILE" \
  "$HERE/manifest/local-inference.json" "$CLAUDE_HOME/kherep/local-inference/config.json" \
  "$EXPECTED_DIR/local-inference.json"

drift=0
# Normalize a file for comparison: machine-absolute ~/.claude path -> portable ~ form (matches
# bootstrap/lib.sh portable_paths) and strip CR so CRLF/LF differences are not flagged.
normalize_file() {
  local source="$1" output="$2"
  node -e '
    const fs=require("fs");
    const [source,target,home]=process.argv.slice(1);
    let text=fs.readFileSync(source,"utf8");
    const variants=new Set([home,home.replace(/\\/g,"/"),JSON.stringify(home).slice(1,-1)]);
    for(const value of variants)if(value)text=text.split(value).join("~/.claude");
    text=text
      .replace(/"cwd": *"[^"]*"/g, `"cwd": ""`)
      .replace(/"\$\(command -v python3 \|\| command -v python\)"/g, "python")
      .replace(/\r/g, "")
      .replace(/\n+$/, "");
    fs.writeFileSync(target,text);
  ' "$source" "$output" "$CLAUDE_HOME"
}

cmp_file() {
  local rel="$1" repo="$2" live="$3" normalized_dir repo_normalized live_normalized
  if [ ! -f "$repo" ]; then printf 'MISSING-REPO  %s (%q)\n' "$rel" "$repo"; drift=1; return; fi
  if [ ! -f "$live" ]; then printf 'MISSING-LIVE  %s (%q)\n' "$rel" "$live"; drift=1; return; fi
  normalized_dir="$(mktemp -d "$EXPECTED_DIR/compare.XXXXXX")" || {
    echo "NORMALIZE-FAIL $rel"; drift=1; return
  }
  repo_normalized="$normalized_dir/repo"
  live_normalized="$normalized_dir/live"
  if ! normalize_file "$repo" "$repo_normalized" || ! normalize_file "$live" "$live_normalized"; then
    echo "NORMALIZE-FAIL $rel"
    drift=1
    rm -rf "$normalized_dir"
    return
  fi
  if diff -q "$repo_normalized" "$live_normalized" >/dev/null 2>&1; then
    echo "ok            $rel"
  else
    echo "DRIFT         $rel"; drift=1
  fi
  rm -rf "$normalized_dir"
}

cmp_tree() {
  local label="$1" repo_dir="$2" live_dir="$3" f sub
  if [ ! -d "$repo_dir" ]; then echo "MISSING-REPO  $label"; drift=1; return; fi
  if [ ! -d "$live_dir" ]; then echo "MISSING-LIVE  $label"; drift=1; return; fi
  while IFS= read -r f; do
    f="${f%$'\r'}"
    sub="${f#"$repo_dir/"}"
    cmp_file "$label/$sub" "$f" "$live_dir/$sub"
  done < <("$FIND_BIN" "$repo_dir" -type f | sort)
  while IFS= read -r f; do
    f="${f%$'\r'}"
    sub="${f#"$live_dir/"}"
    [ "$(basename "$sub")" = ".DS_Store" ] && continue
    if [ ! -f "$repo_dir/$sub" ]; then echo "EXTRA-LIVE    $label/$sub"; drift=1; fi
  done < <("$FIND_BIN" "$live_dir" -type f | sort)
}

if [ "$DRIFT_SCOPE" = "all" ]; then
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    # The live box builds settings.json from settings.user.json and CLAUDE.md from CLAUDE.user.md
    # (capture.sh / install.sh handle both specially - the manifest lists the live-side names).
    if [ "$rel" = "settings.json" ]; then
      cmp_file "$rel" "$EXPECTED_DIR/settings.json" "$CLAUDE_HOME/settings.json"
      continue
    fi
    if [ "$rel" = "CLAUDE.md" ]; then
      cmp_file "$rel" "$CLAUDE_SRC/CLAUDE.user.md" "$CLAUDE_HOME/CLAUDE.md"
      continue
    fi
    repo="$CLAUDE_SRC/$rel"; live="$CLAUDE_HOME/$rel"
    if [ -d "$repo" ]; then
      cmp_tree "$rel" "$repo" "$live"
    else
      cmp_file "$rel" "$repo" "$live"
    fi
  done < "$MANIFEST"
  cmp_file "runtime/local-inference/runner.mts" \
    "$HERE/../modules/local-inference/runner.mts" "$CLAUDE_HOME/kherep/local-inference/runner.mts"
  cmp_tree "runtime/local-inference/lib" \
    "$HERE/../modules/local-inference/lib" "$CLAUDE_HOME/kherep/local-inference/lib"
  cmp_file "runtime/local-inference/config.json" \
    "$EXPECTED_DIR/local-inference.json" "$CLAUDE_HOME/kherep/local-inference/config.json"
  cmp_tree "runtime/twg" \
    "$HERE/../modules/twg/runtime" "$CLAUDE_HOME/kherep/twg"
fi

# Project-scoped rules are installed/captured explicitly and therefore are not
# entries in the user-home manifest. They are nevertheless load-bearing and
# must participate in drift detection.
cmp_file "project/settings.local.json" "$EXPECTED_DIR/settings.local.json" "$WS/.claude/settings.local.json"
cmp_file "project/CLAUDE.md" "$CLAUDE_SRC/CLAUDE.project.md" "$WS/CLAUDE.md"
cmp_file "project/AGENTS.md" "$CLAUDE_SRC/AGENTS.project.md" "$WS/AGENTS.md"
if [ "$INSTALL_ATLASSIAN_TOOLS" = "1" ]; then
cmp_file "project/tools/atlassian-credentials.mts" \
  "$HERE/../modules/atl-jira-brokers/atlassian-credentials.mts" "$WS/tools/atlassian-credentials.mts"
cmp_file "project/tools/atl-jira.mts" \
  "$HERE/../modules/atl-jira-brokers/atl-jira.mts" "$WS/tools/atl-jira.mts"
cmp_file "project/tools/atl-jira-ccoder.mts" \
  "$HERE/../modules/atl-jira-brokers/atl-jira-ccoder.mts" "$WS/tools/atl-jira-ccoder.mts"
cmp_file "project/tools/jira-adf.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-adf.mts" "$WS/tools/jira-adf.mts"
cmp_file "project/tools/jira-config.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-config.mts" "$WS/tools/jira-config.mts"
cmp_file "project/tools/jira-transition-guard.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-transition-guard.mts" "$WS/tools/jira-transition-guard.mts"
cmp_file "project/tools/jira-fields.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-fields.mts" "$WS/tools/jira-fields.mts"
cmp_file "project/tools/jira-links.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-links.mts" "$WS/tools/jira-links.mts"
cmp_file "project/tools/jira-search.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-search.mts" "$WS/tools/jira-search.mts"
cmp_file "project/tools/jira-attach.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-attach.mts" "$WS/tools/jira-attach.mts"
cmp_file "project/tools/jira-adf-text.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-adf-text.mts" "$WS/tools/jira-adf-text.mts"
cmp_file "project/tools/jira-download.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-download.mts" "$WS/tools/jira-download.mts"
cmp_file "project/tools/jira-discovery.mts" \
  "$HERE/../modules/atl-jira-brokers/jira-discovery.mts" "$WS/tools/jira-discovery.mts"
# OP-1405. The Confluence broker. Its sources live in the Jira broker directory
# because the installers copy that directory flat into $WS/tools/.
cmp_file "project/tools/atl-confluence.mts" \
  "$HERE/../modules/atl-jira-brokers/atl-confluence.mts" "$WS/tools/atl-confluence.mts"
cmp_file "project/tools/atl-confluence-ccoder.mts" \
  "$HERE/../modules/atl-jira-brokers/atl-confluence-ccoder.mts" "$WS/tools/atl-confluence-ccoder.mts"
cmp_file "project/tools/confluence-contract.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-contract.mts" "$WS/tools/confluence-contract.mts"
cmp_file "project/tools/confluence-content.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-content.mts" "$WS/tools/confluence-content.mts"
cmp_file "project/tools/confluence-session.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-session.mts" "$WS/tools/confluence-session.mts"
cmp_file "project/tools/confluence-related.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-related.mts" "$WS/tools/confluence-related.mts"
cmp_file "project/tools/confluence-semantic.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-semantic.mts" "$WS/tools/confluence-semantic.mts"
cmp_file "project/tools/confluence-neighbours.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-neighbours.mts" "$WS/tools/confluence-neighbours.mts"
cmp_file "project/tools/confluence-neighbour-cli.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-neighbour-cli.mts" "$WS/tools/confluence-neighbour-cli.mts"
cmp_file "project/tools/confluence-runtime-label.mts" \
  "$HERE/../modules/atl-jira-brokers/confluence-runtime-label.mts" "$WS/tools/confluence-runtime-label.mts"
cmp_file "project/tools/mpac/mpac.ps1" \
  "$HERE/../modules/mpac-tools/mpac.ps1" "$WS/tools/mpac/mpac.ps1"
cmp_file "project/tools/mpac/README.md" \
  "$HERE/../modules/mpac-tools/README.md" "$WS/tools/mpac/README.md"
fi

echo ""
if [ "$drift" -eq 0 ]; then echo "DRIFT-CHECK PASS (repo == live)"; else echo "DRIFT-CHECK FOUND DRIFT (see above)"; fi

if [ -n "$REPORT_TMP" ]; then
  exec 1>&3
  cat "$REPORT_TMP"
  if mv -f "$REPORT_TMP" "$REPORT" 2>/dev/null; then REPORT_TMP=""; fi
fi
exit "$drift"
