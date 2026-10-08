// Issue #331. The observation agent labels a finding evidence-confirmed only
// when the brief marks it `measured:` with the command and the deciding output
// excerpt (claude/agents/claude-obs.md, codex/agents/codex-obs.md). Before, only
// the Stop hooks told a session that format, so a session that dispatched the
// agent on its own never saw it. Both dispatch guards apply this check, which
// puts the format where the brief is written.
//
// A finding starts at a lowercase `measured:` or `relayed:` marker at the start
// of a line, optionally after whitespace and a list bullet (-, *) or a list
// number (1. or 1)), and runs to the next marker or the end of the brief. Text
// before the first marker, such as a summary or a "Scope: <node>" line, is no
// finding. Pure: no I/O, and a reason never quotes the brief.

// The three observation hook reasons state this sentence verbatim
// (bootstrap/observation-agent-contract.test.mts holds them together).
export const OBS_BRIEF_FORMAT =
  "Mark each finding at the start of its own line as measured: `<command>` -> <deciding output excerpt>, or relayed: <source>.";
// Claude's Stop hook accepts this opt-out (claude/hooks/observation-stop.mts).
export const CLAUDE_NOTHING_TO_FILE =
  "If nothing is worth filing, dispatch nothing and end the turn with [obs: none – <reason>].";
// Codex has no opt-out marker; an empty codex-obs result means zero writes.
export const CODEX_NOTHING_TO_FILE =
  "If nothing is worth filing, say so in one relayed: line; an empty result is valid.";

const MARKER = /^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]*)?(measured|relayed):/gm;
// A CommonMark code span: a run of backticks, content, the same run again.
const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/;

interface Finding {
  kind: string;
  text: string;
}

function findings(brief: string): Finding[] {
  const marks = [...brief.matchAll(MARKER)];
  return marks.map((mark, index) => ({
    kind: mark[1],
    text: brief.slice(mark.index + mark[0].length, index + 1 < marks.length ? marks[index + 1].index : brief.length),
  }));
}

function measuredIssue(text: string): string | null {
  const span = CODE_SPAN.exec(text);
  if (!span || !span[2].trim()) return "has no command in an inline code span";
  const rest = text.slice(span.index + span[0].length);
  const arrow = rest.indexOf("->");
  if (arrow < 0) return "has no -> after the command";
  return rest.slice(arrow + 2).trim() ? null : "has no deciding output excerpt after ->";
}

// null when the brief is well-formed, else the deny reason: the first problem,
// the format, and what to do when nothing is worth filing.
export function observationBriefIssue(brief: string, nothingToFile: string = CLAUDE_NOTHING_TO_FILE): string | null {
  const list = findings(brief);
  let problem = list.length ? "" : "the brief marks no finding";
  for (const [index, finding] of list.entries()) {
    const issue = finding.kind === "measured" ? measuredIssue(finding.text)
      : finding.text.trim() ? null : "names no source";
    if (issue) {
      problem = `finding ${index + 1} (${finding.kind}:) ${issue}`;
      break;
    }
  }
  return problem ? `Observation brief format: ${problem}. ${OBS_BRIEF_FORMAT} ${nothingToFile}` : null;
}
