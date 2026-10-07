// Strict, table-driven argument parsing shared by all four Atlassian brokers.
// Each broker declares per verb which flags it reads; the parser and the help
// text are both generated from that one table, so they cannot drift apart.
//
// Strict on purpose: a positional or an unknown flag used to be skipped
// silently, so `get 275907063` lost the id and failed with a message that did
// not say why. Every error here names the verb's full syntax instead.
//
// Named after atlassian-credentials.mts, the other module both broker families
// share: the Confluence brokers are installed without the optional Jira set.

export interface FlagSpec {
  // Flag name -> value placeholder for the help text, e.g. { id: "<id>" }.
  required?: Readonly<Record<string, string>>;
  optional?: Readonly<Record<string, string>>;
  // Presence flags that take no value, e.g. ["body-only"].
  valueless?: readonly string[];
  // Groups of alternatives: at least one flag of each group must be given.
  oneOf?: readonly Readonly<Record<string, string>>[];
}

export type VerbTable = Readonly<Record<string, FlagSpec>>;
export type ParsedArgs = Record<string, string | undefined>;

export class CliArgsError extends Error {}

export interface CliArgsMessages {
  usage: string;
  or: string;
  didYouMean: string;
  noFlags: string;
  helpIntro: string;
  positional: (verb: string, expects: string, token: string) => string;
  unknown: (verb: string, flag: string) => string;
  noValue: (verb: string, flag: string) => string;
  duplicate: (verb: string, flag: string) => string;
  missing: (verb: string, flags: string) => string;
}

export const EN: CliArgsMessages = {
  usage: "Usage",
  or: "or",
  didYouMean: "Did you mean",
  noFlags: "no arguments",
  helpIntro: "Verbs and their flags ([...] is optional):",
  positional: (verb, expects, token) => `${verb} expects ${expects}; got positional '${token}'.`,
  unknown: (verb, flag) => `${verb} does not take ${flag}.`,
  noValue: (verb, flag) => `${verb}: ${flag} needs a value.`,
  duplicate: (verb, flag) => `${verb}: ${flag} was given more than once.`,
  missing: (verb, flags) => `${verb}: ${flags} is missing.`,
};

export const DE: CliArgsMessages = {
  usage: "Nutzung",
  or: "oder",
  didYouMean: "Meinten Sie",
  noFlags: "keine Argumente",
  helpIntro: "Verben und ihre Flags ([...] ist optional):",
  positional: (verb, expects, token) => `${verb} erwartet ${expects}; Positionsargument '${token}' erhalten.`,
  unknown: (verb, flag) => `${verb} kennt ${flag} nicht.`,
  noValue: (verb, flag) => `${verb}: ${flag} braucht einen Wert.`,
  duplicate: (verb, flag) => `${verb}: ${flag} wurde mehrfach angegeben.`,
  missing: (verb, flags) => `${verb}: ${flags} fehlt.`,
};

// A token that looks like a flag cannot be a value: `--body --key OP-1` is a
// body that was forgotten, not a body reading "--key". Text such as "---" or
// "-- note" stays a value.
const FLAG_TOKEN = /^--[A-Za-z][\w-]*$/;

export function isHelp(token: string | undefined): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

function pairs(flags: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(flags ?? {}).map(([name, placeholder]) => `--${name} ${placeholder}`);
}

// Required flags and alternative groups: what a positional most likely meant.
function requiredSyntax(spec: FlagSpec): string[] {
  return [...pairs(spec.required), ...(spec.oneOf ?? []).map((group) => `(${pairs(group).join(" | ")})`)];
}

export function usageLine(verb: string, spec: FlagSpec): string {
  const optional = [...pairs(spec.optional), ...(spec.valueless ?? []).map((name) => `--${name}`)];
  return [verb, ...requiredSyntax(spec), ...optional.map((flag) => `[${flag}]`)].join(" ");
}

export function helpText(table: VerbTable, messages: CliArgsMessages): string[] {
  return [messages.helpIntro, ...Object.entries(table).map(([verb, spec]) => `  ${usageLine(verb, spec)}`)];
}

function shellWord(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : JSON.stringify(token);
}

export function parseVerbArgs(
  verb: string,
  spec: FlagSpec,
  argv: readonly string[],
  messages: CliArgsMessages,
): ParsedArgs {
  const valued = new Set([
    ...Object.keys(spec.required ?? {}),
    ...Object.keys(spec.optional ?? {}),
    ...(spec.oneOf ?? []).flatMap((group) => Object.keys(group)),
  ]);
  const valueless = new Set(spec.valueless ?? []);
  const reject = (line: string, hint?: string): never => {
    const lines = [line];
    if (hint) lines.push(`${messages.didYouMean}: ${hint}`);
    lines.push(`${messages.usage}: ${usageLine(verb, spec)}`);
    throw new CliArgsError(lines.join("\n"));
  };

  const args: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      const given = new Set(argv.filter((other) => other.startsWith("--")).map((other) => other.slice(2)));
      const candidates = [...Object.keys(spec.required ?? {}), ...(spec.oneOf ?? []).map((group) => Object.keys(group)[0])];
      const meant = candidates.find((name) => !given.has(name));
      const expects = requiredSyntax(spec).join(" ") || usageLine(verb, spec).slice(verb.length + 1) || messages.noFlags;
      const rest = argv.length > 1 ? " ..." : "";
      reject(messages.positional(verb, expects, token), meant ? `${verb} --${meant} ${shellWord(token)}${rest}` : undefined);
    }
    const name = token.slice(2);
    const isValueless = valueless.has(name);
    if (!isValueless && !valued.has(name)) reject(messages.unknown(verb, token));
    if (Object.hasOwn(args, name)) reject(messages.duplicate(verb, token));
    if (isValueless) {
      args[name] = "";
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || FLAG_TOKEN.test(value)) reject(messages.noValue(verb, token));
    args[name] = value;
    index += 1;
  }

  for (const name of Object.keys(spec.required ?? {})) {
    if (!Object.hasOwn(args, name)) reject(messages.missing(verb, `--${name}`));
  }
  for (const group of spec.oneOf ?? []) {
    const names = Object.keys(group);
    if (!names.some((name) => Object.hasOwn(args, name))) {
      reject(messages.missing(verb, names.map((name) => `--${name}`).join(` ${messages.or} `)));
    }
  }
  return args;
}
