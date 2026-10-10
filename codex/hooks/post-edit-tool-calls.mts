import { nestedToolCalls, type ParsedToolCall } from "./research-exec-parser.mts";

const READ_ONLY_TOOLS = new Set([
  "mcp__codebase_memory_mcp__index_status",
  "mcp__codebase_memory_mcp__list_projects",
  "mcp__codebase_memory_mcp__search_graph",
  "mcp__codebase_memory_mcp__search_code",
  "mcp__codebase_memory_mcp__trace_path",
  "mcp__codebase_memory_mcp__detect_changes",
  "mcp__codebase_memory_mcp__query_graph",
  "mcp__codebase_memory_mcp__get_graph_schema",
  "mcp__codebase_memory_mcp__get_code_snippet",
  "mcp__codebase_memory_mcp__get_architecture",
]);

function completeLiteralSequence(source: string): boolean {
  let cursor = 0;
  const backtick = String.fromCharCode(96);

  function whitespace(): void {
    while (/\s/.test(source[cursor] || "")) cursor += 1;
  }

  function identifier(): boolean {
    const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
    if (!match) return false;
    cursor += match[0].length;
    return true;
  }

  function stringLiteral(): boolean {
    const quote = source[cursor];
    if (!['"', "'", backtick].includes(quote)) return false;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 1;
        const escaped = source[cursor];
        if (!escaped || /[\r\n]/.test(escaped)) return false;
        if (`\\'\"${backtick}bfnrtv/`.includes(escaped)) {
          cursor += 1;
          continue;
        }
        if (escaped === "0") {
          if (/\d/.test(source[cursor + 1] || "")) return false;
          cursor += 1;
          continue;
        }
        if (escaped === "x") {
          const hex = source.slice(cursor + 1, cursor + 3);
          if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return false;
          cursor += 3;
          continue;
        }
        if (escaped === "u") {
          const braced = /^\{([0-9A-Fa-f]{1,6})\}/.exec(source.slice(cursor + 1));
          if (braced) {
            if (Number.parseInt(braced[1]!, 16) > 0x10FFFF) return false;
            cursor += 1 + braced[0].length;
            continue;
          }
          const hex = source.slice(cursor + 1, cursor + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return false;
          cursor += 5;
          continue;
        }
        return false;
      }
      if (quote !== backtick && /[\r\n]/.test(source[cursor])) return false;
      if (quote === backtick && source.startsWith("$" + "{", cursor)) return false;
      if (source[cursor] === quote) {
        cursor += 1;
        return true;
      }
      cursor += 1;
    }
    return false;
  }

  function propertyName(): boolean {
    if (source[cursor] === backtick) return false;
    return ['"', "'"].includes(source[cursor]) ? stringLiteral() : identifier();
  }

  function value(depth = 0): boolean {
    if (depth > 50) return false;
    whitespace();
    if (['"', "'", backtick].includes(source[cursor])) return stringLiteral();
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor));
    if (number) {
      cursor += number[0].length;
      return true;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, cursor) && !/[\w$]/.test(source[cursor + literal.length] || "")) {
        cursor += literal.length;
        return true;
      }
    }
    if (source[cursor] === "[") {
      cursor += 1;
      whitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return true;
      }
      while (value(depth + 1)) {
        whitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return true;
        }
        if (source[cursor] !== ",") return false;
        cursor += 1;
        whitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return true;
        }
      }
      return false;
    }
    if (source[cursor] === "{") {
      cursor += 1;
      whitespace();
      if (source[cursor] === "}") {
        cursor += 1;
        return true;
      }
      while (true) {
        if (!propertyName()) return false;
        whitespace();
        if (source[cursor] !== ":") return false;
        cursor += 1;
        if (!value(depth + 1)) return false;
        whitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return true;
        }
        if (source[cursor] !== ",") return false;
        cursor += 1;
        whitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return true;
        }
      }
    }
    return false;
  }

  let calls = 0;
  whitespace();
  while (cursor < source.length) {
    if (source.startsWith("await", cursor) && !/[\w$]/.test(source[cursor + 5] || "")) {
      cursor += 5;
      if (!/\s/.test(source[cursor] || "")) return false;
      whitespace();
    }
    if (!source.startsWith("tools.", cursor)) return false;
    cursor += 6;
    if (!identifier()) return false;
    whitespace();
    if (source[cursor] !== "(") return false;
    cursor += 1;
    if (!value()) return false;
    whitespace();
    if (source[cursor] !== ")") return false;
    cursor += 1;
    calls += 1;
    whitespace();
    if (source[cursor] === ";") {
      cursor += 1;
      whitespace();
    } else if (cursor < source.length) {
      return false;
    }
  }
  return calls > 0;
}

export function completeDirectLiteralToolCalls(source: string): ParsedToolCall[] | null {
  if (!completeLiteralSequence(source)) return null;
  const calls = nestedToolCalls(source);
  return calls.length > 0 ? calls : null;
}

export function isCompleteReadOnlyToolSequence(source: string): boolean {
  const calls = completeDirectLiteralToolCalls(source);
  return Boolean(calls?.every(({ name }) => READ_ONLY_TOOLS.has(name)));
}
