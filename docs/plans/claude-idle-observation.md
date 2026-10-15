# Bounded native Claude idle observation

This tool is an opt-in measurement aid for one explicitly selected native Claude session. It is not installed by bootstrap profiles, templates, or defaults. Installation alone never proves that Claude Desktop activated the hook.

The observer accepts a native `Notification` only when `notification_type` is `idle_prompt`, the session ID and arm nonce match, the run is at most ten minutes old, the selected native owner PID and process generation occur in the current bounded ancestry, and the combined observer code identity matches. `SessionStart` and `UserPromptSubmit` are the only activity events installed for invalidation. `Stop`, `agent_completed`, and `agent_needs_input` are not idle evidence.

The native event source is the [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks#notification). A synthetic callback proves parsing and storage behavior only. Live activation requires a separately measured callback from the native application.

> Scope warning: this `Notification/idle_prompt` observer applies to interactive Claude Code CLI sessions. The [Claude Agent SDK does not emit `idle_prompt`](https://code.claude.com/docs/en/agent-sdk/hooks#forward-notifications-to-slack), so a Desktop SDK host cannot be proved idle by this observer and must not wait for this callback.

## CLI contract

All paths must be absolute. The commands print one JSON object and no raw settings or event input.

```text
node bootstrap/idle-observer-install.mts install --settings <file> --run-dir <private-dir> --observer <idle-observer.mts> --session <session-id> --owner-pid <pid> --owner-start <generation> --expires-at <ISO-8601>
node bootstrap/idle-observer-install.mts status --settings <file> --run-dir <private-dir>
node bootstrap/idle-observer-install.mts remove --settings <file> --run-dir <private-dir>
```

On macOS and Linux, obtain `--owner-start` from the selected native process with:

```sh
LC_ALL=C ps -p "$PID" -o lstart=
```

Trim only surrounding whitespace. Preserve every internal space. The observer uses the same `LC_ALL=C` long-start representation while walking at most eight ancestors.

On Windows, `--owner-start` is the decimal string returned by `StartTime.ToFileTimeUtc()` for the selected process. The observer obtains it together with `ParentProcessId` through PowerShell and CIM.

A successful command exits 0 with this fixed schema:

```json
{
  "ok": true,
  "status": "installed | already-installed | removed | already-removed",
  "ownedEntries": 0,
  "observationCount": 0,
  "lastSequence": 0,
  "idleValid": false,
  "activation": "unproven"
}
```

A refusal exits 1:

```json
{"ok":false,"status":"refused","code":"FIXED_REASON_CODE"}
```

`activation` remains `unproven`. An operator must correlate an actual native callback separately. `idleValid` is true only while the run is fresh, the current owner generation still matches, the latest journal event is `Notification/idle_prompt`, and no same-or-later activity witness exists.

## Installed entries

Install adds exactly one uniquely identified command handler to each group:

- `Notification` with matcher `^idle_prompt$`
- `SessionStart` with matcher `*`
- `UserPromptSubmit` without a matcher

The command handler has a ten-second timeout. It does not use `async`, `asyncRewake`, `additionalContext`, wake state, permissions, or messaging. The callback always exits 0 without stdout or stderr.

Install preserves existing hooks, permissions, environment values, unknown settings, the target path, and the supported file security attributes. Settings and receipts use a fully written and flushed same-directory temporary file, copy and verify the original POSIX owner/group/mode or Windows owner/group/DACL, recheck the source identity and hash for concurrent drift, then rename atomically. The replacement changes the filesystem inode or file ID.

On macOS, replacement copies ACL entries and extended attributes with the native metadata-preserving copy operation. It hashes their names and raw values internally and verifies the metadata before writing, after writing, and after rename. Names and values are never emitted. A target with file flags is refused before rename. Windows owner/group/DACL copying is verified before and after rename. Unsupported security inspection or copying is refused rather than broadening permissions.

The installer writes a `prepared` ownership receipt before changing settings and finalizes it as `installed` afterward. A finalization failure attempts a narrow rollback. If an unrelated concurrent settings edit prevents rollback, `remove` uses the prepared receipt to remove only the exact owned handlers while preserving that edit. Removal passes through `removing`, which makes an interrupted cleanup retryable. A receipt becomes `removed` only after readback proves the owned handlers absent.

## Private run files

The run directory is private to the current OS user. Files use private modes or an owner-only Windows ACL.

- `settings.backup`: exact pre-install settings bytes
- `run.json`: run ID, exact session, arm nonce, creation and expiry, owner identity, combined code identity
- `install-receipt.json`: prepared, installed, removing, or removed state, settings and backup hashes, and the three owned handler hashes
- `journal.json`: at most 16 allowlisted event records
- `activity-00.json` through `activity-15.json`: immutable activity witnesses written before journal locking
- `activity-overflow`: conservative invalidation when all activity witness slots are occupied
- `.observer.lock`: transient exclusive journal lock

The combined code identity deterministically hashes `idle-observer.mts` and `idle-observer-process.mts`, including length-delimited filenames and bytes.

An event record may contain only `runId`, `event`, optional `notificationType`, `receivedAt`, `owner` with `pid` and `startedAt`, `codeSha256`, and `sequence`. Raw `message`, `title`, `cwd`, `transcript_path`, prompt, tool input, and tool output are discarded before any event file is written and are never printed.

Each activity callback first claims one bounded witness slot. Lock contention can delay journal ordering but cannot leave a prior idle result valid. A partial witness is retained and makes status refuse. If ordering is ambiguous or witness capacity is exceeded, status invalidates the idle result conservatively. If the filesystem cannot create even an empty witness file, the callback remains silent and no new evidence can be persisted; operators must treat host I/O failure as outside the proof.

The journal retains its first 16 events and stops growing at capacity. It never evicts the first idle receipt that enforces the run's one-shot rule; later activity remains represented by its immutable witness.

## Failure and cleanup semantics

Unknown ancestry, PID reuse, an expired or future run, code drift, a foreign session, malformed data, unsafe ownership, and symbolic-link targets yield no positive observation. Malformed private evidence makes status refuse rather than infer absence.

Run `remove` against the same settings file and run directory. A successful remove is independently read back before it returns. The private run directory remains as measurement evidence until the operator has completed the separately authorized cleanup.
