#!/usr/bin/env bash
# Transaction/failure tests. All paths are below one throwaway root.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; ORIGINAL_PATH="$PATH"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "TRANSACTION TEST FAIL: $*" >&2; exit 1; }
same() { cmp "$1" "$2" >/dev/null || fail "bytes differ: $1"; }
latest() {
  local dirs=("$1"/.claude/backups/bootstrap/install-*) last
  last="${dirs[${#dirs[@]}-1]}"
  [ -d "$last" ] || return 1
  printf '%s\n' "$last"
}

make_dir_symlink() {
  local target="$1" link="$2" link_win target_win
  ln -s "$target" "$link" 2>/dev/null || true
  [ -L "$link" ] && return 0
  rm -rf -- "$link"
  if command -v node >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    link_win="$(cygpath -w "$link")"; target_win="$(cygpath -w "$target")"
    LINK_PATH="$link_win" TARGET_PATH="$target_win" node -e \
      'require("node:fs").symlinkSync(process.env.TARGET_PATH, process.env.LINK_PATH, "junction")' \
      >/dev/null 2>&1 || true
  fi
  [ -L "$link" ] || fail "cannot create a real directory symlink/junction for path tests"
}

fixture() {
  ROOT="$TMP/$1"; H="$ROOT/home"; C="$H/.claude"; W="$ROOT/workspace"; R="$ROOT/credentials"
  mkdir -p "$C/hooks" "$W/.claude" "$R"
  printf '{}\n' > "$C/settings.json"; printf '{}\n' > "$W/.claude/settings.local.json"
  printf old-statusline > "$C/statusline-command.sh"; cp "$C/statusline-command.sh" "$ROOT/status.before"
  printf old-guard > "$C/hooks/commit-guard.js"; cp "$C/hooks/commit-guard.js" "$ROOT/guard.before"
}
install_files() {
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh"
}

# Cross-root contract: a fake mv rejects live<->backup moves. Backup copying,
# sibling live swaps, reverse restore, and an originally absent target must pass.
test_library() {
  local live="$TMP/lib/root-d/live" backup="$TMP/lib/root-c/backup" src="$TMP/lib/src" fake="$TMP/lib/bin" real_mv real_cp real_rm rc
  mkdir -p "$live" "$backup" "$src" "$fake"; printf old > "$live/file"; printf new > "$src/file"
  real_mv="$(command -v mv)"; real_cp="$(command -v cp)"; real_rm="$(command -v rm)"
  cat > "$fake/mv" <<'SH'
#!/usr/bin/env bash
if [ "${FAIL_LIVE_MOVE:-0}" = 1 ] && [[ "$1" == "$LIVE_ROOT/"* ]]; then
  [ -z "${LIVE_MOVE_MARKER:-}" ] || : > "$LIVE_MOVE_MARKER"
  exit 90
fi
if [[ "$1" == "$LIVE_ROOT/"* && "$2" == "$BACKUP_ROOT/"* ]] || [[ "$2" == "$LIVE_ROOT/"* && "$1" == "$BACKUP_ROOT/"* ]]; then exit 88; fi
exec "$REAL_MV" "$@"
SH
  cat > "$fake/cp" <<'SH'
#!/usr/bin/env bash
if [ "${FAIL_RESTORE_COPY:-0}" = 1 ]; then
  case "$3" in */.kherep-restore-*/payload) [ -z "${RESTORE_COPY_MARKER:-}" ] || : > "$RESTORE_COPY_MARKER"; exit 28;; esac
fi
if [ "${EXPECT_HOLDER_BACKUP:-0}" = 1 ]; then
  case "$3" in */.kherep-backup-*/payload)
    case "$2" in */.kherep-previous-*/payload) ;; *) exit 89;; esac
  esac
fi
exec "$REAL_CP" "$@"
SH
  cat > "$fake/rm" <<'SH'
#!/usr/bin/env bash
last="${!#}"
if [ "${FAIL_FAILED_HOLDER_REMOVE:-0}" = 1 ]; then
  case "$last" in */.kherep-failed-*) [ -z "${FAILED_REMOVE_MARKER:-}" ] || : > "$FAILED_REMOVE_MARKER"; exit 13;; esac
fi
exec "$REAL_RM" "$@"
SH
  chmod +x "$fake/mv" "$fake/cp" "$fake/rm"
  export PATH="$fake:$ORIGINAL_PATH" REAL_MV="$real_mv" REAL_CP="$real_cp" REAL_RM="$real_rm" LIVE_ROOT="$live" BACKUP_ROOT="$backup"
  export HOME="$TMP/lib/home" CLAUDE_HOME="$TMP/lib/claude"; source "$HERE/lib.sh"
  transaction_begin "$backup/one" "$live"
  export EXPECT_HOLDER_BACKUP=1; install_path one "$src/file" "$live/file" "$backup/one/original"; unset EXPECT_HOLDER_BACKUP
  [ "$(cat "$backup/one/original")" = old ] || fail "backup not complete before mutation"
  transaction_rollback test; [ "$(cat "$live/file")" = old ] || fail "existing target not restored"
  [ "$(cat "$backup/one/failed/000000")" = new ] || fail "failed target not parked"

  mkdir "$src/identical" "$live/identical"; printf same > "$src/identical/SKILL.md"; cp "$src/identical/SKILL.md" "$live/identical/SKILL.md"
  transaction_begin "$backup/identical" "$live"
  FAIL_LIVE_MOVE=1 LIVE_MOVE_MARKER="$TMP/lib/live-move-attempted" install_path identical "$src/identical" "$live/identical" "$backup/identical/original"
  [ ! -e "$TMP/lib/live-move-attempted" ] || fail "identical directory reached live rename"
  [ "$TX_COUNT" -eq 0 ] && [ ! -e "$backup/identical/original" ] || fail "identical directory was journaled or backed up"
  printf changed > "$src/identical/SKILL.md"
  set +e; install_path duplicate "$src/identical" "$live/identical" "$backup/identical/duplicate" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] && [ "$(cat "$live/identical/SKILL.md")" = same ] || fail "equal-first duplicate target was accepted"
  transaction_rollback test

  mkdir "$src/different" "$live/different"; printf new > "$src/different/SKILL.md"; printf old > "$live/different/SKILL.md"; printf extra > "$live/different/extra"
  transaction_begin "$backup/different" "$live"
  install_path different "$src/different" "$live/different" "$backup/different/original"
  [ "$(cat "$live/different/SKILL.md")" = new ] && [ ! -e "$live/different/extra" ] || fail "different directory did not use normal replacement"
  [ "$(cat "$backup/different/original/SKILL.md")" = old ] && [ -e "$backup/different/original/extra" ] || fail "different directory backup incomplete"
  transaction_rollback test
  transaction_begin "$backup/two" "$live"; install_path two "$src/file" "$live/absent" "$backup/two/original"
  transaction_rollback test; [ ! -e "$live/absent" ] || fail "absent target survived rollback"

  transaction_begin "$backup/parents" "$live"
  install_path parents "$src/file" "$live/new-parent/nested/file" "$backup/parents/original"
  transaction_rollback test
  [ ! -e "$live/new-parent" ] || fail "transaction-created live parents survived rollback"

  # A failed in-flight swap retains the exact same-filesystem original and
  # restores it directly, without needing another possibly ENOSPC copy.
  printf old-inflight > "$live/inflight"
  transaction_begin "$backup/three" "$live"
  set +e; KHEREP_BOOTSTRAP_TEST_FAIL_SWAP_LABEL=inflight install_path inflight "$src/file" "$live/inflight" "$backup/three/original"; rc=$?; set -e
  [ "$rc" -eq 96 ] || fail "in-flight swap injection did not fire"
  FAIL_RESTORE_COPY=1 RESTORE_COPY_MARKER="$TMP/lib/restore-copy-attempted" transaction_rollback test
  [ "$(cat "$live/inflight")" = old-inflight ] || fail "in-flight original was not restored directly"
  [ ! -e "$TMP/lib/restore-copy-attempted" ] || fail "in-flight rollback unnecessarily copied backup"

  # If a completed entry really needs a backup copy and that copy fails, live
  # remains present, the original backup survives, and recovery is explicit.
  printf old-diskfull > "$live/diskfull"
  transaction_begin "$backup/four" "$live"; install_path diskfull "$src/file" "$live/diskfull" "$backup/four/original"
  set +e; FAIL_RESTORE_COPY=1 RESTORE_COPY_MARKER="$TMP/lib/restore-copy-failed" transaction_rollback test; rc=$?; set -e
  [ "$rc" -ne 0 ] && [ -e "$TMP/lib/restore-copy-failed" ] || fail "restore-copy failure was not exercised"
  [ "$(cat "$live/diskfull")" = new ] || fail "restore-copy failure left live target missing"
  [ "$(cat "$backup/four/original")" = old-diskfull ] || fail "restore-copy failure lost original backup"
  [ -f "$backup/four/ROLLBACK-INCOMPLETE" ] || fail "restore-copy failure lacks incomplete marker"

  printf old-remove > "$live/remove-fail"
  transaction_begin "$backup/remove-fail" "$live"; install_path remove-fail "$src/file" "$live/remove-fail" "$backup/remove-fail/original"
  set +e; FAIL_FAILED_HOLDER_REMOVE=1 FAILED_REMOVE_MARKER="$TMP/lib/remove-failed" transaction_rollback test; rc=$?; set -e
  [ "$rc" -ne 0 ] && [ -e "$TMP/lib/remove-failed" ] || fail "failed-holder removal error was swallowed"
  [ -f "$backup/remove-fail/ROLLBACK-INCOMPLETE" ] || fail "holder removal failure lacks incomplete marker"
  [ "$(cat "$live/remove-fail")" = old-remove ] || fail "holder removal failure lost restored original"
  PATH="$ORIGINAL_PATH"; unset REAL_MV REAL_CP REAL_RM LIVE_ROOT BACKUP_ROOT
}

# OP-1136. Retirement parks a live file the repo no longer manages. It is never
# a delete (Golden Rule 1): the file moves into a _deprecated/ sibling, its exact
# prior version is copied into the install backup, and rollback puts it back at
# the original path. A rolled-back retirement leaves the parked copy where it is;
# the dated suffix is what keeps the next run from overwriting it.
test_retire() {
  local live="$TMP/retire/live" backup="$TMP/retire/backup" out
  local crowded="$TMP/retire/crowded" stamp=19700101-000000 parked
  mkdir -p "$live/hooks" "$backup"
  printf orphan > "$live/hooks/em-dash-watch.js"

  transaction_begin "$backup/one" "$live"
  transaction_retire_path hooks/em-dash-watch.js "$live/hooks/em-dash-watch.js"     "$backup/one/retired/hooks/em-dash-watch.js" > /dev/null
  [ ! -e "$live/hooks/em-dash-watch.js" ] || fail "retired file stayed at its live path"
  [ "$(cat "$live/hooks/_deprecated/em-dash-watch.js")" = orphan ] || fail "retired file was not parked in _deprecated"
  [ "$(cat "$backup/one/retired/hooks/em-dash-watch.js")" = orphan ] || fail "retired file was not backed up"
  transaction_rollback test
  [ "$(cat "$live/hooks/em-dash-watch.js")" = orphan ] || fail "rollback did not restore the retired file"

  transaction_begin "$backup/two" "$live"
  out="$(transaction_retire_path hooks/gone.js "$live/hooks/gone.js" "$backup/two/retired/hooks/gone.js")"
  case "$out" in *SKIP*) ;; *) fail "an absent retirement target did not report SKIP: $out" ;; esac
  [ "$TX_COUNT" -eq 0 ] || fail "an absent retirement target was journalled"
  [ ! -e "$backup/two/retired/hooks/gone.js" ] || fail "an absent retirement target produced a backup"
  transaction_rollback test

  printf second > "$live/hooks/em-dash-watch.js"
  transaction_begin "$backup/three" "$live"
  transaction_retire_path hooks/em-dash-watch.js "$live/hooks/em-dash-watch.js"     "$backup/three/retired/hooks/em-dash-watch.js" > /dev/null
  [ "$(cat "$live/hooks/_deprecated/em-dash-watch.js")" = orphan ] || fail "an already parked file was overwritten"
  compgen -G "$live/hooks/_deprecated/em-dash-watch.js.*" > /dev/null || fail "the second retirement got no dated sibling"
  [ "$(cat "$live/hooks/_deprecated/em-dash-watch.js".*)" = second ] || fail "the dated sibling holds the wrong bytes"
  transaction_commit

  # A third retirement inside the same second: both the plain destination and the
  # dated candidate are taken. The suffix has to count up instead of aborting the
  # install. TX_RETIRE_STAMP pins the stamp so the collision is deterministic.
  parked="$crowded/hooks/_deprecated/em-dash-watch.js"
  mkdir -p "$crowded/hooks/_deprecated"
  printf first > "$parked"; printf dated > "$parked.$stamp"
  printf third > "$crowded/hooks/em-dash-watch.js"
  cp "$crowded/hooks/em-dash-watch.js" "$TMP/retire/third.before"
  transaction_begin "$backup/four" "$crowded"
  TX_RETIRE_STAMP="$stamp" transaction_retire_path hooks/em-dash-watch.js "$crowded/hooks/em-dash-watch.js"     "$backup/four/retired/hooks/em-dash-watch.js" > /dev/null
  unset TX_RETIRE_STAMP
  [ "$(cat "$parked")" = first ] || fail "a same-second collision overwrote the parked file"
  [ "$(cat "$parked.$stamp")" = dated ] || fail "a same-second collision overwrote the dated sibling"
  [ -e "$parked.$stamp-1" ] || fail "a same-second collision got no counted sibling"
  same "$parked.$stamp-1" "$TMP/retire/third.before"
  transaction_commit
}

test_lock() {
  local lock="$TMP/lock/bootstrap.lock" rc stale
  mkdir -p "$(dirname "$lock")"
  source "$HERE/install-lock.sh"
  bootstrap_lock_acquire "$lock"
  set +e; ( source "$HERE/install-lock.sh"; bootstrap_lock_acquire "$lock" ) >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 3 ] || fail "concurrent bootstrap lock did not report an active owner (rc=$rc)"
  bootstrap_lock_release
  [ ! -e "$lock" ] || fail "released bootstrap lock still blocks acquisition"
  mkdir "$lock"; printf '%s\n' 'pid=999999' 'token=dead-owner' > "$lock/owner"
  bootstrap_lock_acquire "$lock"
  stale=("$lock".stale-999999-*)
  [ -d "${stale[0]}" ] || fail "dead bootstrap lock was not quarantined"
  bootstrap_lock_release
  [ ! -e "$lock" ] || fail "recovered bootstrap lock was not released"
}

test_preflights() {
  local rc
  fixture preflight
  set +e
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=mac KHEREP_WORKSPACE='D:\Work' KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" >/dev/null 2>&1; rc=$?
  set -e
  [ "$rc" -ne 0 ] && [ ! -d "$C/backups" ] || fail "invalid Mac path mutated bootstrap state"
  printf '{bad-json\n' > "$C/settings.json"
  set +e; install_files >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "malformed settings passed preflight"
  same "$C/statusline-command.sh" "$ROOT/status.before"
}

test_path_guards() {
  local rc outside before src b target

  # Root and manifest gates are lexical and run before bootstrap state exists.
  (
    KHEREP_PROFILE=win; source "$HERE/profile.sh"
    ! kherep_validate_shell_path TEST_ROOT / >/dev/null 2>&1
    ! kherep_validate_shell_path TEST_PARENT /safe/../escape >/dev/null 2>&1
    ! kherep_validate_shell_path TEST_BACKSLASH 'D:\escape' >/dev/null 2>&1
    ! kherep_validate_manifest_relative_path TEST_MANIFEST '../outside' >/dev/null 2>&1
    kherep_validate_manifest_relative_path TEST_MANIFEST 'hooks/lib/guard.js' >/dev/null
  ) || fail "root or manifest lexical path gate regressed"

  fixture containment; outside="$ROOT/outside"; src="$ROOT/src"; mkdir -p "$outside" "$src"
  printf outside-sentinel > "$outside/sentinel"; cp "$outside/sentinel" "$ROOT/outside.before"
  printf managed > "$src/file"
  transaction_begin "$ROOT/backup-one" "$C"
  set +e; install_path escape "$src/file" "$outside/sentinel" "$ROOT/backup-one/original" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "target outside allowed root was accepted"
  transaction_rollback containment >/dev/null 2>&1 || true
  same "$outside/sentinel" "$ROOT/outside.before"
  cp "$outside/sentinel" "$src/equal"
  transaction_begin "$ROOT/backup-equal-escape" "$C"
  set +e; install_path equal-escape "$src/equal" "$outside/sentinel" "$ROOT/backup-equal-escape/original" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "byte-identical target outside allowed root was accepted"
  transaction_rollback containment >/dev/null 2>&1 || true
  same "$outside/sentinel" "$ROOT/outside.before"
  transaction_begin "$ROOT/backup-two" "$C"
  set +e; install_path backup-escape "$src/file" "$C/contained" "$outside/backup" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "backup outside allowed root was accepted"
  transaction_rollback containment >/dev/null 2>&1 || true
  same "$outside/sentinel" "$ROOT/outside.before"; [ ! -e "$outside/backup" ] || fail "outside backup was created"

  for target in hooks hooks-lib workspace-dot-claude local-inference; do
    fixture "symlink-$target"; outside="$ROOT/outside"; before="$ROOT/outside.before"
    mkdir -p "$outside"; printf "outside-$target" > "$outside/sentinel"; cp "$outside/sentinel" "$before"
    case "$target" in
      hooks) rm -rf -- "$C/hooks"; make_dir_symlink "$outside" "$C/hooks" ;;
      hooks-lib) mkdir -p "$C/hooks"; make_dir_symlink "$outside" "$C/hooks/lib" ;;
      workspace-dot-claude) rm -rf -- "$W/.claude"; make_dir_symlink "$outside" "$W/.claude" ;;
      local-inference) mkdir -p "$C/kherep"; make_dir_symlink "$outside" "$C/kherep/local-inference" ;;
    esac
    set +e; install_files > "$ROOT/log" 2>&1; rc=$?; set -e
    [ "$rc" -ne 0 ] || fail "symlink ancestor passed preflight: $target"
    same "$outside/sentinel" "$before"
    [ ! -d "$C/backups" ] || fail "symlink preflight created bootstrap state: $target"
  done
}

test_partial() {
  local rc b
  fixture partial
  set +e; KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL='hooks/deploy-guard.js' install_files > "$ROOT/log" 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "partial failure returned success"
  same "$C/statusline-command.sh" "$ROOT/status.before"; same "$C/hooks/commit-guard.js" "$ROOT/guard.before"
  [ ! -e "$C/hooks/deploy-guard.js" ] || fail "new target survived partial rollback"
  b="$(latest "$H")"; [ -f "$b/ROLLED-BACK" ] || fail "partial rollback marker missing"
}

test_term() {
  local pid rc b marker
  fixture term; marker="$ROOT/paused"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_LABEL='hooks/commit-guard.js' \
    KHEREP_BOOTSTRAP_TEST_MARKER="$marker" bash "$HERE/install.sh" > "$ROOT/log" 2>&1 & pid=$!
  for ((i=0; i<200; i++)); do [ ! -e "$marker" ] || break; sleep 0.1; done
  [ -e "$marker" ] || { kill -TERM "$pid" 2>/dev/null || true; fail "TERM checkpoint missing"; }
  kill -TERM "$pid"; set +e; wait "$pid"; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "TERM returned success"
  same "$C/statusline-command.sh" "$ROOT/status.before"; same "$C/hooks/commit-guard.js" "$ROOT/guard.before"
  b="$(latest "$H")"; [ -f "$b/ROLLED-BACK" ] && grep -q SIGTERM "$b/ROLLBACK-REASON" || fail "TERM not journaled"
}

test_commit_signal() {
  local pid rc b marker
  fixture commit; marker="$ROOT/commit-durable"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_COMMIT_MARKER="$marker" \
    bash "$HERE/install.sh" > "$ROOT/log" 2>&1 & pid=$!
  for ((i=0; i<1200; i++)); do [ ! -e "$marker" ] || break; sleep 0.1; done
  [ -e "$marker" ] || { kill -TERM "$pid" 2>/dev/null || true; fail "commit checkpoint missing"; }
  kill -TERM "$pid"; set +e; wait "$pid"; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "commit-race TERM returned success"
  b="$(latest "$H")"
  [ -f "$b/COMMITTED" ] && [ ! -e "$b/ROLLED-BACK" ] && [ ! -e "$b/ACTIVE" ] || fail "durable commit was rolled back or contradictory"
  cmp "$C/statusline-command.sh" "$HERE/../claude/statusline-command.sh" >/dev/null || fail "durably committed live target was reverted"
}

test_secrets() {
  local yaml age bin rc b f
  fixture secrets; yaml="$ROOT/plain.yaml"; age="$ROOT/age.key"; bin="$ROOT/bin"
  mkdir -p "$bin" "$ROOT/before"; printf x > "$age"
  printf '%s\n' '{"old":true}' > "$C/.mcp.json"; printf '%s\n' '#!/usr/bin/env bash' 'echo old' > "$C/registry-http-bridge.sh"
  for f in .mcp.json registry-http-bridge.sh; do mkdir -p "$ROOT/before/$(dirname "$f")"; cp "$C/$f" "$ROOT/before/$f"; done
  node -e 'const fs=require("fs"),b=s=>Buffer.from(s).toString("base64"),v={mcp_json:b("{\"mcpServers\":{}}\n"),fixture_service_sh:b("#!/usr/bin/env bash\necho new\n")};fs.writeFileSync(process.argv[1],"data:\n"+Object.entries(v).map(([k,x])=>`  ${k}: ${x}`).join("\n")+"\n")' "$yaml"
  cat > "$bin/sops" <<'SH'
#!/usr/bin/env bash
exec cat "$FAKE_SOPS_YAML"
SH
  chmod +x "$bin/sops"
  set +e
  PATH="$bin:$ORIGINAL_PATH" FAKE_SOPS_YAML="$yaml" HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win \
    KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" SOPS_AGE_KEY_FILE="$age" \
    KHEREP_SECRETS_BUNDLE="$yaml" \
    KHEREP_BOOTSTRAP_TEST_FAIL_SWAP_LABEL='secrets/.mcp.json' SKIP_SECRETS=0 SKIP_DEPS=1 \
    bash "$HERE/install.sh" > "$ROOT/log" 2>&1; rc=$?
  set -e; [ "$rc" -ne 0 ] || fail "secret swap failure returned success"
  for f in .mcp.json registry-http-bridge.sh; do same "$C/$f" "$ROOT/before/$f"; done
  same "$C/statusline-command.sh" "$ROOT/status.before"
  b="$(latest "$H")" || fail "secret fixture did not reach an installation transaction"
  [ -f "$b/ROLLED-BACK" ] && [ -f "$b/secrets/.mcp.json" ] || fail "secret rollback/backup missing"
  ! compgen -G "$C/backups/bootstrap/preflight-*" >/dev/null || fail "secret preflight not cleaned"
}

# OP-1432. The observation agent is installed by default, so the Confluence
# brokers and exactly the modules they import are too - without the Atlassian
# switch, which keeps gating only the Jira helpers.
test_default_confluence_brokers() {
  local rc tool
  fixture confluence
  set +e
  env -u KHEREP_INSTALL_ATLASSIAN_TOOLS HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || { cat "$ROOT/log"; fail "default install failed (rc=$rc)"; }
  for tool in atlassian-credentials.mts confluence-contract.mts confluence-content.mts confluence-session.mts \
    confluence-related.mts confluence-semantic.mts confluence-neighbours.mts confluence-neighbour-cli.mts \
    confluence-runtime-label.mts atl-confluence.mts atl-confluence-ccoder.mts; do
    same "$HERE/../modules/atl-jira-brokers/$tool" "$W/tools/$tool"
  done
  for tool in atl-jira.mts atl-jira-ccoder.mts jira-adf.mts jira-config.mts; do
    [ ! -e "$W/tools/$tool" ] || fail "default install projected the optional helper $tool"
  done
  grep -qF "node <workspace>/tools/atl-confluence-ccoder.mts" "$C/agents/claude-obs.md" ||
    fail "installed claude-obs.md lacks the ccoder invocation"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after a default install"; }
}

# Kherep no longer ships the MPAC tools (#25). Hosts that installed them earlier
# keep <workspace>/tools/mpac/ as unmanaged operator content: an upgrade with the
# Atlassian switch on must leave both files byte-identical, and drift-check must
# no longer compare them.
test_upgrade_keeps_mpac() {
  local rc f
  fixture mpac
  mkdir -p "$W/tools/mpac" "$ROOT/mpac.before"
  printf 'operator mpac script\n' > "$W/tools/mpac/mpac.ps1"
  printf 'operator mpac notes\n' > "$W/tools/mpac/README.md"
  cp "$W/tools/mpac/mpac.ps1" "$W/tools/mpac/README.md" "$ROOT/mpac.before/"
  set +e
  KHEREP_INSTALL_ATLASSIAN_TOOLS=1 HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || { cat "$ROOT/log"; fail "upgrade install with the Atlassian switch failed (rc=$rc)"; }
  for f in mpac.ps1 README.md; do same "$W/tools/mpac/$f" "$ROOT/mpac.before/$f"; done
  same "$HERE/../modules/atl-jira-brokers/atl-jira.mts" "$W/tools/atl-jira.mts"
  KHEREP_INSTALL_ATLASSIAN_TOOLS=1 HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after an upgrade over existing MPAC tools"; }
  ! grep -qi mpac "$ROOT/drift.log" || { cat "$ROOT/drift.log"; fail "drift-check still reports the MPAC tools"; }
}

# OP-1085: the deps phase runs AFTER the commit and must not be able to undo an
# install. The fake npm answers every install with the Mac EEXIST; the plugin
# step fails too, via an unreachable claude binary. The install is forced through
# the pinned manifest entry instead of the original `bun` line: a real bun on the
# host PATH would legitimately hit the present-outside-npm skip and make the
# assertion host-dependent (that branch has its own case in npm-globals.test.mts).
# Expected: COMMITTED, no rollback, the gitconfig phase still ran, exit 1, and
# the managed files on disk pass drift-check.
test_deps_failure() {
  local rc b fake_npm
  fixture deps
  cat > "$ROOT/fake-npm.js" <<'JS'
"use strict";
const args = process.argv.slice(2);
const signature = args.join(" ");
// Everything satisfied except the pinned transport entry, which must install.
const dependencies = {
  "@anthropic-ai/claude-code": { version: "9.9.9" },
  "@forge/cli": { version: "9.9.9" },
  "@openai/codex": { version: "9.9.9" },
  "claude-baton": { version: "9.9.9" },
  "mcp-remote": { version: "9.9.9" },
  supergateway: { version: "3.0.0" },
  bun: { version: "9.9.9" },
};
if (signature === "ls -g --depth=0 --json") {
  process.stdout.write(JSON.stringify({ name: "npm", dependencies }));
} else if (signature === "prefix -g") {
  process.stdout.write(process.env.FAKE_NPM_PREFIX + "\n");
} else if (args.slice(0, 2).join(" ") === "i -g") {
  process.stderr.write(`EEXIST: file already exists (${args[2]})\n`);
  process.exit(1);
} else {
  process.exit(64);
}
JS
  # Git Bash rewrites POSIX paths in argv for native programs, never in the
  # environment: the fake path travels in KHEREP_NPM_BIN_ARGS_JSON and must
  # already be Windows-shaped when node opens it.
  fake_npm="$ROOT/fake-npm.js"
  ! command -v cygpath >/dev/null 2>&1 || fake_npm="$(cygpath -m "$fake_npm")"
  # This is the only case here that runs past the commit into C2 and C3. Both
  # read real per-host state (the knowledge space, the Atlassian credential) and
  # check it live, so they sit behind their skip switches like in smoke-test.sh.
  set +e
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
    SKIP_SECRETS=1 SKIP_DEPS=0 FAKE_NPM_PREFIX="$ROOT/npm-prefix" \
    KHEREP_NPM_BIN="$(node -p 'process.execPath')" KHEREP_NPM_BIN_ARGS_JSON="[\"$fake_npm\"]" \
    KHEREP_CLAUDE_BIN="$ROOT/no-such-claude" bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 1 ] || fail "failing deps phase did not exit 1 (rc=$rc)"
  grep -q 'npm-globals: supergateway install (pinned' "$ROOT/log" || fail "manifest pin was not enforced"
  grep -q 'npm-globals: supergateway FAILED' "$ROOT/log" || fail "fake npm EEXIST was not reported"
  grep -q 'install: DONE WITH ERRORS' "$ROOT/log" || fail "failing deps phase lacks the DONE WITH ERRORS verdict"
  grep -q "install: git core.hooksPath -> $C/kherep/githooks" "$ROOT/log" ||
    fail "gitconfig phase was skipped after the deps failure"
  b="$(latest "$H")"
  [ -f "$b/COMMITTED" ] || fail "deps failure left the transaction uncommitted"
  [ ! -e "$b/ROLLED-BACK" ] && [ ! -e "$b/ACTIVE" ] || fail "deps failure rolled the managed files back"
  ! compgen -G "$C/backups/bootstrap/preflight-*" >/dev/null || fail "deps failure left the preflight behind"
  [ ! -e "$C/backups/bootstrap/.install.lock" ] || fail "deps failure kept the install lock"
  cmp "$C/statusline-command.sh" "$HERE/../claude/statusline-command.sh" >/dev/null ||
    fail "deps failure did not leave the managed file installed"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after a committed install with a failed deps phase"; }
}

test_library; test_retire; test_lock; test_preflights; test_path_guards; test_partial; test_term; test_commit_signal; test_secrets
test_deps_failure; test_default_confluence_brokers; test_upgrade_keeps_mpac
echo 'TRANSACTION TEST PASS'
