#!/usr/bin/env node
import type { SpawnSyncOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { LocalInferenceConfig } from "./lib/config.mts";
import type { ModelList } from "./lib/transport.mts";
import {
  DEFAULT_CONFIG, assertLoopback, assertSshHost, detectProfile, endpointUrl, ensureBackend,
  loadConfig, outputPath, portablePaths, resolveSpec, run, sshJson,
} from "./runner.mts";

const TEST_CONFIG: LocalInferenceConfig = {
  schemaVersion: 2,
  backends: {
    win: {
      engine: "vLLM", endpoint: "http://127.0.0.1:8000/v1", model: "test-model",
      keepAlive: ["test-keepalive"], start: ["test-start"], readyAttempts: 1, readyDelayMs: 0,
    },
    mac: {
      engine: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "discover",
      start: ["~/.lmstudio/bin/lms", "daemon", "up"], readyAttempts: 1, readyDelayMs: 0,
    },
  },
  profiles: {
    win: { backends: {
      win: { transport: "local" },
      mac: { transport: "ssh", sshHost: "model-host.invalid" },
    } },
    mac: { backends: { mac: { transport: "local" } } },
  },
};

interface SpawnCall { command: string; args: string[]; options: SpawnSyncOptions }
interface CapturedBody { messages: { content: string }[]; chat_template_kwargs?: { enable_thinking?: boolean } }

let pass = 0, fail = 0;
function check(name: string, condition: unknown): void {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"} | ${name}`);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

(async () => {
  check("Darwin auto-detects the Mac host profile", detectProfile({}, "darwin") === "mac");
  check("non-Darwin auto-detects the Windows host profile", detectProfile({}, "win32") === "win");
  check("explicit KHEREP_PROFILE wins over platform", detectProfile({ KHEREP_PROFILE: "win" }, "darwin") === "win");
  check("another vendor profile variable is ignored", detectProfile({ OTHER_VENDOR_PROFILE: "win" }, "darwin") === "mac");
  check("empty canonical profile fails closed", (() => {
    try { detectProfile({ KHEREP_PROFILE: "", OTHER_VENDOR_PROFILE: "win" }, "darwin"); return false; }
    catch (error) { return /KHEREP_PROFILE/.test(message(error)); }
  })());
  let invalidProfile = false;
  try { detectProfile({ KHEREP_PROFILE: "linux" }, "darwin"); } catch (error) { invalidProfile = /win or mac/.test(message(error)); }
  check("invalid host profiles fail closed", invalidProfile);

  const darwinPaths = portablePaths("mac", { HOME: "/Users/tester" });
  check("Darwin workspace derives from a neutral HOME location", darwinPaths.workspace === "/Users/tester/Kherep");
  check("Darwin credentials root derives from a neutral private HOME location", darwinPaths.credentials === "/Users/tester/.kherep/credentials");
  check("Darwin output has no Windows drive default", darwinPaths.output === "/Users/tester/Kherep/analysis/local-inference" && !darwinPaths.output.includes("D:"));
  const customDarwinPaths = portablePaths("mac", {
    HOME: "/Users/tester", KHEREP_WORKSPACE: "/Volumes/work", KHEREP_CREDENTIALS_ROOT: "/Volumes/private",
  });
  check("Darwin honors portable workspace and credential overrides", customDarwinPaths.workspace === "/Volumes/work" && customDarwinPaths.credentials === "/Volumes/private");
  const preferredPaths = portablePaths("mac", {
    HOME: "/Users/tester", KHEREP_WORKSPACE: "/Volumes/new", OTHER_VENDOR_WORKSPACE: "/Volumes/old",
  });
  check("canonical workspace ignores another vendor variable", preferredPaths.workspace === "/Volumes/new");
  const defaultWinPaths = portablePaths("win", { HOME: "C:\\Users\\tester" });
  check("Windows defaults derive only from HOME", defaultWinPaths.workspace === "C:\\Users\\tester\\Kherep"
    && defaultWinPaths.credentials === "C:\\Users\\tester\\.kherep\\credentials");
  for (const suffix of ["WORKSPACE", "CREDENTIALS_ROOT", "LOCAL_OUTPUT_ROOT"] as const) {
    let rejected = false;
    try { portablePaths("mac", { HOME: "/Users/tester", [`KHEREP_${suffix}`]: "", [`OTHER_VENDOR_${suffix}`]: "/legacy" }); }
    catch (error) { rejected = new RegExp(`KHEREP_${suffix}`).test(message(error)); }
    check(`empty canonical ${suffix} fails without legacy fallback`, rejected);
  }

  check("safe built-in config has no guessed routes", DEFAULT_CONFIG.schemaVersion === 2
    && Object.keys(DEFAULT_CONFIG.backends).length === 0
    && Object.values(DEFAULT_CONFIG.profiles).every((item) => Object.keys(item.backends).length === 0));
  const winLocal = resolveSpec(TEST_CONFIG, "win", "win", {});
  const winToMac = resolveSpec(TEST_CONFIG, "win", "mac", {});
  const macLocal = resolveSpec(TEST_CONFIG, "mac", "mac", {});
  let macToWinUnavailable = false;
  try { resolveSpec(TEST_CONFIG, "mac", "win", {}); }
  catch (error) { macToWinUnavailable = /unsupported/.test(message(error)); }
  check("Windows profile uses local vLLM", winLocal.transport === "local" && /127\.0\.0\.1:8000/.test(winLocal.endpoint));
  check("Windows profile reaches a synthetic Mac only through SSH", winToMac.transport === "ssh" && winToMac.sshHost === "model-host.invalid");
  check("Mac profile uses local LM Studio", macLocal.transport === "local" && /127\.0\.0\.1:1234/.test(macLocal.endpoint));
  check("Mac-to-Windows is structurally unsupported", macToWinUnavailable);
  const injectedRoute = clone(TEST_CONFIG);
  injectedRoute.profiles.mac.backends.win = { transport: "ssh", sshHost: "example-win.invalid" };
  let injectedMacToWinRejected = false;
  try { resolveSpec(injectedRoute, "mac", "win", { KHEREP_WIN_SSH_HOST: "other-win.invalid" }); }
  catch (error) { injectedMacToWinRejected = /unsupported/.test(message(error)); }
  check("custom config cannot re-enable Mac-to-Windows", injectedMacToWinRejected);
  check("OpenAI routes preserve the v1 prefix", endpointUrl(macLocal.endpoint, "/models") === "http://127.0.0.1:1234/v1/models");

  let lanRejected = false;
  try { assertLoopback("http://192.0.2.1:1234/v1"); } catch (error) { lanRejected = /use SSH/.test(message(error)); }
  check("plaintext LAN inference endpoints are rejected", lanRejected);
  let nonHttpRejected = false;
  try { assertLoopback("file://localhost/tmp/model"); } catch (error) { nonHttpRejected = /HTTP/.test(message(error)); }
  check("loopback endpoints still require HTTP(S)", nonHttpRejected);
  let sshOptionRejected = false;
  try { assertSshHost("-oProxyCommand=bad"); } catch (error) { sshOptionRejected = /plain/.test(message(error)); }
  check("SSH destinations reject option injection", sshOptionRejected);

  const sshCalls: SpawnCall[] = [];
  const sshSpawn = (command: string, args: string[], options: SpawnSyncOptions) => {
    sshCalls.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify({ data: [{ id: "remote-model" }] }) };
  };
  const remoteModels = sshJson(winToMac, "/models", "GET", undefined, 1000, sshSpawn) as ModelList;
  sshJson(winToMac, "/chat/completions", "POST", { marker: "BODY-ONLY" }, 1000, sshSpawn);
  check("remote model route stays on target loopback", remoteModels.data?.[0]?.id === "remote-model" && String(sshCalls[0].args.at(-1)).includes("http://127.0.0.1:1234/v1/models"));
  check("remote chat route stays on target loopback", String(sshCalls[1].args.at(-1)).includes("http://127.0.0.1:1234/v1/chat/completions"));
  check("remote request body travels on SSH stdin", String(sshCalls[1].options.input).includes("BODY-ONLY") && !sshCalls[1].args.join(" ").includes("BODY-ONLY"));
  check("remote inference SSH is noninteractive and strict-host-keyed", sshCalls.every((item) => item.args.includes("BatchMode=yes") && item.args.includes("StrictHostKeyChecking=yes")));

  const nativeConfig = clone(TEST_CONFIG);
  nativeConfig.backends.mac.readyAttempts = 1;
  const nativeSpawns: { command: string; args: string[] }[] = [];
  let nativeRequests = 0;
  let nativeError = "";
  try {
    await run(["--backend", "mac", "--task", "public model check"], {
      platform: "darwin",
      env: { HOME: "/Users/tester", KHEREP_PROFILE: "mac" },
      config: nativeConfig,
      requestJson: async (url) => {
        nativeRequests++;
        if (nativeRequests === 1) throw new Error("offline");
        check("native Mac probes only loopback", url === "http://127.0.0.1:1234/v1/models");
        return { data: [] };
      },
      spawnSync: (command, args) => { nativeSpawns.push({ command, args }); return { status: 0 }; },
      sleep: async () => {},
    });
  } catch (error) { nativeError = message(error); }
  check("native Mac starts LM Studio with the direct lms executable", nativeSpawns.length === 1 && nativeSpawns[0].command === "/Users/tester/.lmstudio/bin/lms" && nativeSpawns[0].args.join(" ") === "daemon up");
  check("native Mac start never shells back through SSH", nativeSpawns.every((item) => item.command !== "ssh"));
  check("empty native Mac model list fails with actionable guidance", /no loaded model/.test(nativeError) && /lms ls/.test(nativeError));

  const remoteSpec = { ...winToMac };
  remoteSpec.readyAttempts = 1;
  const remoteStartCalls: SpawnCall[] = [];
  let remoteProbe = 0;
  const remoteSpawn = (command: string, args: string[], options: SpawnSyncOptions) => {
    remoteStartCalls.push({ command, args, options });
    const remote = String(args.at(-1));
    if (remote.includes("curl") && remote.includes("/models")) {
      remoteProbe++;
      return remoteProbe === 1
        ? { status: 1, stdout: "" }
        : { status: 0, stdout: JSON.stringify({ data: [{ id: "mac-model" }] }) };
    }
    return { status: 0, stdout: "" };
  };
  const ready = await ensureBackend(remoteSpec, "/Users/tester", { spawnSync: remoteSpawn, sleep: async () => {} });
  check("Windows starts remote Mac LM Studio through SSH", remoteStartCalls.some((item) => item.command === "ssh" && /lms daemon up/.test(String(item.args.at(-1)))));
  check("Windows never executes Mac lms locally", remoteStartCalls.every((item) => item.command === "ssh"));
  check("remote Mac readiness uses SSH-localhost", ready.models.data?.[0]?.id === "mac-model" && remoteStartCalls.filter((item) => String(item.args.at(-1)).includes("curl")).every((item) => String(item.args.at(-1)).includes("127.0.0.1:1234")));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-inference-"));
  const allowed = path.join(root, "allowed");
  const output = path.join(root, "output");
  const privateDir = path.join(allowed, "host_vars");
  fs.mkdirSync(privateDir, { recursive: true });
  const privateFile = path.join(privateDir, "prod.yml");
  fs.writeFileSync(privateFile, "api_token: TEST-SECRET\n", "utf8");

  let lastBody: CapturedBody | null = null;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-local" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        lastBody = JSON.parse(raw) as CapturedBody;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "RESULT: validation finding; secret redacted" } }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const env = {
    ...process.env,
    KHEREP_PROFILE: "win",
    KHEREP_LOCAL_INPUT_ROOTS: allowed,
    KHEREP_LOCAL_OUTPUT_ROOT: output,
    KHEREP_LOCAL_ALLOW_ENDPOINT_OVERRIDE: "1",
  };

  try {
    const result = await run([
      "--backend", "win", "--endpoint", endpoint,
      "--task", "Review the supplied inventory without reproducing secret values",
      "--input-file", privateFile, "--reveal-output",
    ], { env, config: TEST_CONFIG });
    check("private run succeeds", result.status === "ok" && result.private === true && result.host_profile === "win");
    check("private response not returned to caller", result.response === undefined);
    check("artifact stays under output root", path.resolve(result.artifact).startsWith(path.resolve(output)));
    const artifact = JSON.parse(fs.readFileSync(result.artifact, "utf8")) as { host_profile: string; transport: string; inputs: { sha256: string }[] };
    check("artifact records profile, transport and input hash", artifact.host_profile === "win" && artifact.transport === "local" && /^[a-f0-9]{64}$/.test(artifact.inputs[0].sha256));
    const artifactDigest = crypto.createHash("sha256").update(fs.readFileSync(result.artifact)).digest("hex");
    check("artifact receipt hashes the exact file bytes", result.artifact_sha256 === artifactDigest);
    const received = lastBody as CapturedBody | null;
    check("loopback endpoint received the local file", received?.messages[1].content.includes("TEST-SECRET"));
    check("lookup disables Win thinking", received?.chat_template_kwargs?.enable_thinking === false);
    check("metadata stdout shape contains no input content", !JSON.stringify(result).includes("TEST-SECRET"));

    const escapedOutput = path.join(root, "escaped-output");
    fs.mkdirSync(escapedOutput);
    const outputLink = path.join(output, "escape-link");
    fs.symlinkSync(escapedOutput, outputLink, process.platform === "win32" ? "junction" : "dir");
    let outputSymlinkRejected = false;
    try { outputPath(path.join(outputLink, "artifact.json"), "fixture", output); }
    catch (error) { outputSymlinkRejected = /symlink/.test(message(error)); }
    check("artifact parent cannot escape through a symlink", outputSymlinkRejected);
    let outputRootRejected = false;
    try { outputPath(output, "fixture", output); }
    catch (error) { outputRootRejected = /outside/.test(message(error)); }
    check("artifact output cannot resolve to the output directory itself", outputRootRejected);
    let existingArtifactRejected = false;
    try { outputPath(result.artifact, "fixture", output); }
    catch (error) { existingArtifactRejected = /already exists/.test(message(error)); }
    check("existing artifacts are never overwritten", existingArtifactRejected);

    const customCredentials = path.join(root, "vault");
    fs.mkdirSync(customCredentials, { recursive: true });
    const customCredentialFile = path.join(customCredentials, "plain.yml");
    fs.writeFileSync(customCredentialFile, "credential: ANOTHER-SECRET\n", "utf8");
    const customCredentialResult = await run([
      "--backend", "win", "--endpoint", endpoint, "--task", "Review the supplied file",
      "--input-file", customCredentialFile, "--reveal-output",
    ], {
      env: {
        ...env,
        KHEREP_CREDENTIALS_ROOT: customCredentials,
        KHEREP_LOCAL_INPUT_ROOTS: `${allowed};${customCredentials}`,
      },
      config: TEST_CONFIG,
    });
    check("a custom credentials root is always private", customCredentialResult.private === true && customCredentialResult.response === undefined);
    let publicCredentialRejected = false;
    try {
      await run([
        "--backend", "win", "--endpoint", endpoint, "--task", "Review the supplied file",
        "--input-file", customCredentialFile, "--public", "--reveal-output",
      ], {
        env: { ...env, KHEREP_CREDENTIALS_ROOT: customCredentials, KHEREP_LOCAL_INPUT_ROOTS: `${allowed};${customCredentials}` },
      config: TEST_CONFIG,
      });
    } catch (error) { publicCredentialRejected = /conflicts with privacy/.test(message(error)); }
    check("explicit public classification cannot override credential privacy", publicCredentialRejected);

    const ordinaryFile = path.join(allowed, "ordinary.txt");
    fs.writeFileSync(ordinaryFile, "public fixture\n", "utf8");
    const defaultFileResult = await run([
      "--backend", "win", "--endpoint", endpoint, "--task", "Summarize the supplied file",
      "--input-file", ordinaryFile, "--reveal-output",
    ], { env, config: TEST_CONFIG });
    check("ordinary file input defaults private", defaultFileResult.private === true && defaultFileResult.response === undefined);
    const explicitPublicResult = await run([
      "--backend", "win", "--endpoint", endpoint, "--task", "Summarize the supplied public file",
      "--input-file", ordinaryFile, "--public", "--reveal-output",
    ], { env, config: TEST_CONFIG });
    check("explicitly public file input may reveal output", explicitPublicResult.private === false && explicitPublicResult.response?.includes("RESULT"));

    const publicResult = await run([
      "--backend", "win", "--endpoint", endpoint,
      "--task", "Give a public lookup result", "--reveal-output",
    ], { env, config: TEST_CONFIG });
    check("non-private output may be revealed", publicResult.private === false && publicResult.response?.includes("RESULT"));

    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "x", "utf8");
    let rejected = false;
    try {
      await run(["--backend", "win", "--endpoint", endpoint, "--task", "read", "--input-file", outside], { env, config: TEST_CONFIG });
    } catch (error) { rejected = /outside approved/.test(message(error)); }
    check("input outside approved roots rejected", rejected);

    const invalidUtf8 = path.join(allowed, "invalid.txt");
    fs.writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
    let invalidUtf8Rejected = false;
    try {
      await run(["--backend", "win", "--endpoint", endpoint, "--task", "read", "--input-file", invalidUtf8], { env, config: TEST_CONFIG });
    } catch (error) { invalidUtf8Rejected = /valid UTF-8/.test(message(error)); }
    check("non-UTF8 input is rejected instead of hashing transformed text", invalidUtf8Rejected);

    const brokenConfig = path.join(root, "broken-config.json");
    fs.writeFileSync(brokenConfig, "{not-json", "utf8");
    let brokenConfigRejected = false;
    try { loadConfig({ KHEREP_LOCAL_CONFIG: brokenConfig }); }
    catch (error) { brokenConfigRejected = /Cannot load local-inference config/.test(message(error)); }
    check("an existing malformed config fails closed", brokenConfigRejected);
    check("a missing config uses the safe built-in defaults", loadConfig({ KHEREP_LOCAL_CONFIG: path.join(root, "missing.json") }).schemaVersion === 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n=== ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
