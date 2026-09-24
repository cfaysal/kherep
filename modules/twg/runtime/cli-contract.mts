import { fail, TwgError } from "./errors.mts";

const INPUT_OPERATIONS = new Set(["jira-get", "jira-search", "confluence-search"]);
export type InputOperation = "jira-get" | "jira-search" | "confluence-search";
export type ParsedCli = { operation: "help" | "status" } | { operation: InputOperation; input: string };

export function parseCli(argv: string[]): ParsedCli {
  const [operation, input, ...rest] = argv;
  if (operation === "help" && input === undefined) return { operation };
  if (operation === "status" && input === undefined) return { operation };
  if (!INPUT_OPERATIONS.has(operation) || rest.length || typeof input !== "string") {
    fail("TWG_USAGE", "Use one documented TWG read operation.");
  }
  const value = input.trim();
  if (!value || value.length > 1_000 || value.startsWith("-") || /[\r\n\0]/.test(value)) {
    fail("TWG_USAGE", "The TWG read input is invalid.");
  }
  if (operation === "jira-get" && !/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(value)) {
    fail("TWG_USAGE", "jira-get requires an uppercase Jira work item key.");
  }
  return { operation: operation as InputOperation, input: value };
}

export { TwgError };
