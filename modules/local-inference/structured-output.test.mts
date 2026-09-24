#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalInferenceConfig } from "./lib/config.mts";
import { run, type Runtime } from "./runner.mts";

let pass = 0;
let fail = 0;
function check(name: string, condition: unknown): void {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"} | ${name}`);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runtime(
  root: string, onBody: (body: unknown) => void, onCall: (url: string) => void = () => {}, content = '{"kind":"discovery"}',
): Runtime {
  const profile = process.platform === "darwin" ? "mac" : "win";
  const config: LocalInferenceConfig = {
    schemaVersion: 2,
    backends: {
      mac: { engine: "synthetic", endpoint: "http://127.0.0.1:1234/v1", model: "discover" },
    },
    profiles: {
      win: { backends: {} },
      mac: { backends: {} },
    },
  };
  config.profiles[profile].backends.mac = { transport: "local" };
  return {
    platform: process.platform,
    env: {
      ...process.env,
      KHEREP_PROFILE: profile,
      KHEREP_WORKSPACE: root,
      KHEREP_CREDENTIALS_ROOT: path.join(root, "credentials"),
      KHEREP_LOCAL_OUTPUT_ROOT: path.join(root, "output"),
    },
    config,
    requestJson: async (url, method, body) => {
      onCall(url);
      if (url.endsWith("/models")) return { data: [{ id: "live-test-model" }] };
      onBody(body);
      return { choices: [{ message: { content } }] };
    },
  };
}

const strictSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["discovery", "bugfix", "decision"] },
  },
  required: ["kind"],
  additionalProperties: false,
};

interface InvalidCase { name: string; file: string; raw?: string; value?: unknown }

(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-inference-schema-")));
  const schemaFile = path.join(root, "fixtures", "discovery.schema.json");
  writeJson(schemaFile, strictSchema);

  try {
    let requestBody: Record<string, unknown> | undefined;
    const result = await run([
      "--backend", "mac",
      "--public",
      "--task", "Return one allowed classification",
      "--json-schema", schemaFile,
    ], runtime(root, (body) => { requestBody = body as Record<string, unknown>; }));

    check("strict schema reaches the OpenAI-compatible request body", JSON.stringify(requestBody?.response_format) === JSON.stringify({
      type: "json_schema",
      json_schema: {
        name: "structured_response",
        strict: true,
        schema: strictSchema,
      },
    }));
    check("safe receipt reports only the structured-output capability", result.structured_output === true
      && result.json_parsed === true
      && result.schema_valid === true
      && result.response === undefined
      && !Object.hasOwn(result, "endpoint")
      && !JSON.stringify(result).includes(schemaFile)
      && !JSON.stringify(result).includes("discovery"));

    const invalidJson = await run([
      "--backend", "mac", "--public", "--task", "Classify", "--json-schema", schemaFile,
    ], runtime(root, () => {}, () => {}, "not JSON"));
    check("invalid model JSON is reduced to safe false counters", invalidJson.json_parsed === false
      && invalidJson.schema_valid === false && invalidJson.response === undefined);

    const invalidShape = await run([
      "--backend", "mac", "--public", "--task", "Classify", "--json-schema", schemaFile,
    ], runtime(root, () => {}, () => {}, '{"kind":"other","extra":true}'));
    check("parsed output that violates the schema is reported without raw output", invalidShape.json_parsed === true
      && invalidShape.schema_valid === false && invalidShape.response === undefined
      && !JSON.stringify(invalidShape).includes("other"));

    const unstructured = await run([
      "--backend", "mac", "--task", "Return plain text",
    ], runtime(root, () => {}, () => {}, "plain text"));
    check("unstructured receipts retain their previous shape", !Object.hasOwn(unstructured, "structured_output")
      && !Object.hasOwn(unstructured, "json_parsed") && !Object.hasOwn(unstructured, "schema_valid"));
    const defaultPrivate = await run([
      "--backend", "mac",
      "--task", "Return one allowed classification",
      "--json-schema", schemaFile,
      "--reveal-output",
    ], runtime(root, () => {}));
    check("schema files default to private without explicit public attestation", defaultPrivate.private === true
      && defaultPrivate.response === undefined);

    const markedDir = path.join(root, "host_vars");
    const markedSchema = path.join(markedDir, "marked.schema.json");
    writeJson(markedSchema, strictSchema);
    let markedCalls = 0;
    let markedMessage = "";
    try {
      await run([
        "--backend", "mac", "--public", "--task", "Classify", "--json-schema", markedSchema,
      ], runtime(root, () => {}, () => { markedCalls++; }));
    } catch (error) {
      markedMessage = message(error);
    }
    check("public attestation cannot override a privacy-marked schema path", markedCalls === 0
      && /conflicts with privacy/i.test(markedMessage));
    check("privacy conflict diagnostic hides the schema path", !markedMessage.includes(markedSchema));

    const invalidCases: InvalidCase[] = [
      {
        name: "malformed JSON",
        file: path.join(root, "fixtures", "malformed.json"),
        raw: "{not-json",
      },
      {
        name: "non-object root",
        file: path.join(root, "fixtures", "array.json"),
        value: { type: "array", items: { type: "string" } },
      },
      {
        name: "unknown JSON Schema type",
        file: path.join(root, "fixtures", "unknown-type.json"),
        value: {
          type: "object",
          properties: { kind: { type: "unknown" } },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      {
        name: "unsupported patternProperties",
        file: path.join(root, "fixtures", "pattern-properties.json"),
        value: { ...strictSchema, patternProperties: { "[": { type: "string" } } },
      },
      {
        name: "non-boolean uniqueItems",
        file: path.join(root, "fixtures", "unique-items.json"),
        value: { ...strictSchema, uniqueItems: "yes" },
      },
      {
        name: "unsupported empty combinator",
        file: path.join(root, "fixtures", "empty-any-of.json"),
        value: { ...strictSchema, anyOf: [] },
      },
      {
        name: "open object",
        file: path.join(root, "fixtures", "open.json"),
        value: { type: "object", properties: {}, required: [], additionalProperties: true },
      },
      {
        name: "optional object property",
        file: path.join(root, "fixtures", "optional.json"),
        value: {
          type: "object",
          properties: { hiddenMarker: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "nested open object",
        file: path.join(root, "fixtures", "nested-open.json"),
        value: {
          type: "object",
          properties: {
            nested: { type: "object", properties: {}, required: [], additionalProperties: true },
          },
          required: ["nested"],
          additionalProperties: false,
        },
      },
    ];

    for (const testCase of invalidCases) {
      if (testCase.raw !== undefined) fs.writeFileSync(testCase.file, testCase.raw, "utf8");
      else writeJson(testCase.file, testCase.value);
      let backendCalls = 0;
      let text = "";
      try {
        await run([
          "--backend", "mac", "--task", "Classify", "--json-schema", testCase.file,
        ], runtime(root, () => {}, () => { backendCalls++; }));
      } catch (error) {
        text = message(error);
      }
      check(`${testCase.name} fails before backend access`, backendCalls === 0 && /strict JSON schema/i.test(text));
      check(`${testCase.name} diagnostic does not reproduce path or schema data`, !text.includes(testCase.file)
        && !text.includes("hiddenMarker") && !text.includes("not-json"));
    }

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outside-schema-"));
    const outsideFile = path.join(outsideRoot, "outside.json");
    writeJson(outsideFile, strictSchema);
    let outsideCalls = 0;
    let outsideMessage = "";
    try {
      await run([
        "--backend", "mac", "--task", "Classify", "--json-schema", outsideFile,
      ], runtime(root, () => {}, () => { outsideCalls++; }));
    } catch (error) {
      outsideMessage = message(error);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
    check("schema outside workspace fails before backend access", outsideCalls === 0
      && /strict JSON schema/i.test(outsideMessage));
    check("outside-workspace diagnostic hides the rejected path", !outsideMessage.includes(outsideFile));

    let missingValueCalls = 0;
    let missingValueMessage = "";
    try {
      await run([
        "--backend", "mac", "--task", "Classify", "--json-schema",
      ], runtime(root, () => {}, () => { missingValueCalls++; }));
    } catch (error) {
      missingValueMessage = message(error);
    }
    check("missing schema flag value fails before backend access", missingValueCalls === 0
      && /strict JSON schema/i.test(missingValueMessage));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`RESULT | pass=${pass} fail=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
