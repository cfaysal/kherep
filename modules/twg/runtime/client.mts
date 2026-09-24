import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCli } from "./cli-contract.mts";
import type { InputOperation } from "./cli-contract.mts";
import { fail, TwgError } from "./errors.mts";
import { resolveTwgBinary } from "./resolve-binary.mts";
import type { ResolveTwgBinaryOptions } from "./resolve-binary.mts";

const MAX_OUTPUT = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface TwgProcessError extends Error {
  code?: string | number;
  killed?: boolean;
}

export type TwgExecCallback = (error: TwgProcessError | null, stdout: string, stderr: string) => void;
export interface TwgExecOptions {
  encoding: "utf8";
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: true;
}
export type TwgExecFile = (
  executable: string,
  args: string[],
  options: TwgExecOptions,
  callback: TwgExecCallback,
) => unknown;
export interface TwgClientOptions extends ResolveTwgBinaryOptions {
  execFileImpl?: TwgExecFile;
  resolveBinary?: (options: TwgClientOptions) => string;
  tmpdir?: string;
}

export interface TwgClient {
  status(): Promise<unknown>;
  jiraGet(key: string): Promise<unknown>;
  jiraSearch(jql: string): Promise<unknown>;
  confluenceSearch(query: string): Promise<unknown>;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("TWG_OUTPUT_INVALID", `TWG returned an invalid ${field}.`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail("TWG_OUTPUT_INVALID", `TWG returned an invalid ${field}.`);
  return value;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parseEnvelope(resultText: string, command: string): unknown {
  if (typeof resultText !== "string" || Buffer.byteLength(resultText) > MAX_OUTPUT) {
    fail("TWG_OUTPUT_LIMIT", "TWG output exceeded the supported limit.");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(resultText); } catch { fail("TWG_OUTPUT_INVALID", "TWG returned malformed JSON."); }
  if (object(envelope) && (envelope.error || (Array.isArray(envelope.errors) && envelope.errors.length) || envelope.success === false)) {
    fail("TWG_COMMAND_ERROR", "TWG reported a command error.");
  }
  if (!object(envelope) || envelope.command !== command || envelope.data === undefined || envelope.data === null) {
    fail("TWG_OUTPUT_INVALID", "TWG returned an unexpected response shape.");
  }
  return envelope.data;
}

function projectStatus(data: unknown): Record<string, unknown> {
  if (!object(data) || !object(data.auth)) {
    fail("TWG_OUTPUT_INVALID", "TWG returned an incomplete doctor response.");
  }
  const configured = object(data.auth.config) ? data.auth.config.loaded : undefined;
  const tokenPresent = object(data.auth.resolved) ? data.auth.resolved.tokenPresent : undefined;
  if (configured === false || tokenPresent === false) {
    fail("TWG_AUTH_REQUIRED", "TWG authentication is unavailable.");
  }
  if (!object(data.build) || !object(data.connectivity) || !object(data.skills) || !object(data.upkeep)) {
    fail("TWG_OUTPUT_INVALID", "TWG returned an incomplete doctor response.");
  }
  return {
    version: text(data.build.version, "version"),
    authConfigured: bool(configured, "authentication status"),
    tokenPresent: bool(tokenPresent, "authentication resolution"),
    connectivityAttempted: bool(data.connectivity.attempted, "connectivity attempt"),
    connectivityOk: bool(data.connectivity.ok, "connectivity status"),
    canonicalSkillsInstalled: bool(data.skills.canonicalExists, "canonical skill status"),
    upkeepStatus: text(data.upkeep.status, "upkeep status"),
  };
}

function projectJiraGet(data: unknown, expectedKey: string): Record<string, unknown> {
  const issues = Array.isArray(data) ? data : [data];
  const issue: unknown = issues[0];
  if (issues.length !== 1 || !object(issue) || !object(issue.status) || issue.key !== expectedKey) {
    fail("TWG_OUTPUT_INVALID", "TWG returned an invalid work item.");
  }
  return {
    key: text(issue.key, "work item key"),
    summary: text(issue.summary, "work item summary"),
    status: text(issue.status.name, "work item status"),
  };
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field);
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function projectJiraSearch(data: unknown): Record<string, unknown> {
  if (!object(data) || !Array.isArray(data.issues) || data.issues.length > 25) {
    fail("TWG_OUTPUT_INVALID", "TWG returned an invalid work item query.");
  }
  const issues = data.issues.map((issue: unknown) => {
    if (!object(issue) || !object(issue.status)) fail("TWG_OUTPUT_INVALID", "TWG returned an invalid work item row.");
    return compact({
      key: text(issue.key, "work item key"),
      summary: text(issue.summary, "work item summary"),
      status: text(issue.status.name, "work item status"),
      url: optionalText(issue.url, "work item URL"),
      updated: optionalText(issue.updated, "work item update time"),
    });
  });
  return { issues, returned: issues.length, limit: 25 };
}

function projectConfluenceSearch(data: unknown): Record<string, unknown> {
  if (!object(data) || !Array.isArray(data.results) || data.results.length > 25 || !isInteger(data.size) || !isInteger(data.totalSize)) {
    fail("TWG_OUTPUT_INVALID", "TWG returned an invalid Confluence search.");
  }
  if (data.nextCursor !== null && data.nextCursor !== undefined && typeof data.nextCursor !== "string") {
    fail("TWG_OUTPUT_INVALID", "TWG returned an invalid Confluence cursor.");
  }
  const results = data.results.map((row: unknown) => {
    if (!object(row)) fail("TWG_OUTPUT_INVALID", "TWG returned an invalid Confluence result.");
    const content = object(row.content) ? row.content : {};
    const container = object(row.resultGlobalContainer) ? row.resultGlobalContainer : {};
    const id = text(content.id ?? row.id, "Confluence content id");
    const title = text(row.title ?? content.title, "Confluence title");
    return compact({
      id,
      title,
      type: optionalText(row.entityType ?? content.type ?? row.type, "Confluence content type"),
      status: optionalText(content.status, "Confluence content status"),
      url: optionalText(row.url, "Confluence URL"),
      excerpt: optionalText(row.excerpt, "Confluence excerpt"),
      space: optionalText(container.title, "Confluence space"),
      lastModified: optionalText(row.lastModified, "Confluence update time"),
    });
  });
  return { results, size: data.size, totalSize: data.totalSize, nextCursor: data.nextCursor ?? null };
}

export function createTwgClient(options: TwgClientOptions = {}): TwgClient {
  const execFileImpl = options.execFileImpl || execFile as unknown as TwgExecFile;
  const binary = () => (options.resolveBinary || resolveTwgBinary)(options);
  function run<T>(args: string[], command: string, project: (data: unknown) => T): Promise<T> {
    const executable = binary();
    return new Promise<T>((resolve, reject) => {
      const tempDir = fs.mkdtempSync(path.join(options.tmpdir || os.tmpdir(), "kherep-twg-"));
      const outputFile = path.join(tempDir, "result.json");
      const expectedOutput = path.join(fs.realpathSync(tempDir), "result.json");
      const commandArgs = [...args, "--output-file", outputFile];
      const complete: TwgExecCallback = (error) => {
        try {
          if (error) {
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("TWG_OUTPUT_LIMIT", "TWG output exceeded the supported limit.");
            fail(error.killed ? "TWG_TIMEOUT" : "TWG_PROCESS_FAILED", error.killed ? "TWG command timed out." : "TWG command failed.");
          }
          const stat = fs.lstatSync(outputFile, { throwIfNoEntry: false });
          if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail("TWG_OUTPUT_INVALID", "TWG did not produce a regular JSON result.");
          if (fs.realpathSync(outputFile) !== expectedOutput) fail("TWG_OUTPUT_INVALID", "TWG redirected the JSON result path.");
          if (stat.size > MAX_OUTPUT) fail("TWG_OUTPUT_LIMIT", "TWG output exceeded the supported limit.");
          resolve(project(parseEnvelope(fs.readFileSync(outputFile, "utf8"), command)));
        } catch (cause) { reject(cause); }
        finally { fs.rmSync(tempDir, { force: true, recursive: true }); }
      };
      try {
        execFileImpl(executable, commandArgs, {
          encoding: "utf8", maxBuffer: 64 * 1024, shell: false, timeout: 15_000, windowsHide: true,
        }, complete);
      } catch {
        fs.rmSync(tempDir, { force: true, recursive: true });
        reject(new TwgError("TWG_PROCESS_FAILED", "TWG command failed."));
      }
    });
  }
  const inputFor = (operation: InputOperation, input: string): string => {
    const parsed = parseCli([operation, input]);
    return "input" in parsed ? parsed.input : fail("TWG_USAGE", "The TWG read input is invalid.");
  };
  return {
    status: () => run(["doctor", "-o", "json"], "doctor.get", projectStatus),
    jiraGet(key: string) {
      const value = inputFor("jira-get", key);
      return run(
        ["jira", "workitem", "get", value, "--fields", "summary,status", "-o", "json"],
        "jira.workitem.get", (data) => projectJiraGet(data, value),
      );
    },
    jiraSearch(jql: string) {
      const value = inputFor("jira-search", jql);
      return run([
        "jira", "workitem", "query", "--jql", value, "--limit", "25",
        "--save-jqlto-user-history", "false", "-o", "json",
      ], "jira.workitem.query", projectJiraSearch);
    },
    confluenceSearch(query: string) {
      const value = inputFor("confluence-search", query);
      return run([
        "confluence", "search", "text", value, "--limit", "25", "-o", "json",
      ], "confluence.search.text", projectConfluenceSearch);
    },
  };
}

export { TwgError };
