# Kherep working rules

The Kherep working rules are installed at user level: the Kherep installer writes them to the user-level `CLAUDE.md` in the Claude configuration home (by default `~/.claude/CLAUDE.md`). Claude Code loads that file in every session, so this workspace file neither repeats nor imports it.

If the user-level rules are missing, run the Kherep installer instead of copying the rules into this file.
