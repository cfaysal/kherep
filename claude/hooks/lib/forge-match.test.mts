// Issues #328 and #347. The segment-anchored Forge checks behind deploy-guard rules 1, 2 and 4.
// Pure: no forge, no file system, so every case is a plain table row.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  forgeDeployVerdict, forgeInstallVerdict, forgeInvocations, forgeTunnelVerdict, legacyForgeDeploy, legacyForgeInstall, legacyForgeTunnel,
} from "./forge-match.mts";

const deploy = (command: string) => forgeDeployVerdict(command);
const install = (command: string) => forgeInstallVerdict(command).verdict;

// The false positives measured in the issue: blocked before, none now.
const FALSE_POSITIVES: Array<[string, (command: string) => string]> = [
  ['forge deploy -e development && echo "-e production"', deploy],
  ["forge deploy -e development; grep -e production log.txt", deploy],
  ['forge deploy -e development && gh issue create --body "deployed -e production"', deploy],
  ["forge install --environment development && grep -s pattern file", install],
  ["forge install -e development; rsync -s a b", install],
  ["forge deploy -e development && forge install -e production", deploy],
  ["forge deploy -e development && forge install -e production", install],
];

// The false negatives measured in the issue, and the forms the parser reads.
const DEPLOYS_PRODUCTION: string[] = [
  'forge deploy -e "production"',
  "forge deploy --environment 'production'",
  "forge deploy -eproduction",
  "forge.cmd deploy -e production",
  "npx @forge/cli deploy -e production",
  "npx @forge/cli@latest deploy -e production",
  "forge deploy -e production",
  "forge deploy -e=production",
  "forge deploy --environment=production",
  "forge deploy --environment production",
  "forge deploy -e production-eu",
  "forge deploy -e prod",
  "forge deploy -e PRODUCTION",
  "forge.exe deploy -e production",
  "C:\\Users\\x\\AppData\\Roaming\\npm\\forge.cmd deploy -e production",
  "./node_modules/.bin/forge deploy -e production",
  "forge --verbose deploy -e production",
  "forge deploy --non-interactive -e production",
  "cd app && forge deploy -e production",
  "forge deploy \\\n  -e production",
  "forge deploy -e production 2>&1 | tee deploy.log",
  'ssh example-host "cd app && forge deploy -e production"',
  "bash -c 'forge deploy -e production'",
  "echo $(forge deploy -e production)",
  "forge lint; forge deploy -e production",
];

const DEPLOYS_ELSEWHERE: string[] = [
  "forge deploy",
  "forge deploy -e development",
  "forge deploy -e staging",
  "forge deploy -e producer",
  "forge deploy -e products",
  "forge deploy --environment=development",
  "forge build -e production",
  "forge logs -e production",
  "forge deploy -e development > production.log",
  "npm run deploy -e production",
  "forgery deploy -e production",
];

const INSTALLS_ON_SITE: Array<[string, string]> = [
  ["forge install --site example.atlassian.net", "example.atlassian.net"],
  ["forge install -s example.atlassian.net", "example.atlassian.net"],
  ['forge install --site "example.atlassian.net"', "example.atlassian.net"],
  ["forge install --site=example.atlassian.net", "example.atlassian.net"],
  ["forge install -s=example.atlassian.net", "example.atlassian.net"],
  ["forge install -sexample.atlassian.net", "example.atlassian.net"],
  ["forge install --upgrade --site example.atlassian.net", "example.atlassian.net"],
  ["forge.cmd install -s example.atlassian.net", "example.atlassian.net"],
  ["npx @forge/cli install --site example.atlassian.net", "example.atlassian.net"],
  ["bash -c 'forge install --site example.atlassian.net'", "example.atlassian.net"],
];

// Operator decisions 2 and 4: no site, an upgrade without a site and the
// read-only `install list` pass.
const INSTALLS_ELSEWHERE: string[] = [
  "forge install",
  "forge install --upgrade",
  "forge install -e production",
  "forge install --product jira",
  "forge install list",
  "forge install list --site example.atlassian.net",
  "forge deploy --site example.atlassian.net",
  "forge install -e development && ls -s",
];

test("issue false positives are none", () => {
  for (const [command, verdict] of FALSE_POSITIVES) assert.equal(verdict(command), "none", command);
});

test("production deploys match, also the forms the regexes missed", () => {
  for (const command of DEPLOYS_PRODUCTION) assert.equal(forgeDeployVerdict(command), "match", command);
});

test("deploys to other environments and other forge verbs are none", () => {
  for (const command of DEPLOYS_ELSEWHERE) assert.equal(forgeDeployVerdict(command), "none", command);
});

test("an install on a named site matches and names the site", () => {
  for (const [command, site] of INSTALLS_ON_SITE) assert.deepEqual(forgeInstallVerdict(command), { verdict: "match", site }, command);
});

test("installs without a site and install list are none", () => {
  for (const command of INSTALLS_ELSEWHERE) assert.equal(install(command), "none", command);
});

// Issue #327, decision 2 (variant B): a quoted word is scanned again as shell,
// without an interpreter allow-list, so quoted text that spells a complete
// command stays blocked, as it was before #328.
test("quoted text that spells a complete forge command still matches", () => {
  assert.equal(install('echo "forge install --site x"'), "match");
  assert.equal(deploy('node broker.mts comment --body "forge deploy -e production"'), "match");
});

test("an unparseable command is uncertain, and the legacy regexes decide it", () => {
  assert.equal(deploy('forge deploy -e development "unterminated'), "uncertain");
  assert.equal(deploy('forge deploy -e "production'), "match");
  assert.equal(install("forge install $(echo"), "uncertain");
  assert.equal(deploy(undefined as never), "uncertain");
  assert.equal(install(undefined as never), "uncertain");
});

test("legacy functions keep the regexes of rules 1 and 2 before #328", () => {
  assert.equal(legacyForgeDeploy("forge deploy -e production"), true);
  assert.equal(legacyForgeDeploy("forge deploy -e development && echo '-e production'"), true);
  assert.equal(legacyForgeDeploy('forge deploy -e "production"'), false);
  assert.equal(legacyForgeDeploy("forge.cmd deploy -e production"), false);
  assert.equal(legacyForgeInstall("forge install --site example.atlassian.net"), "example.atlassian.net");
  assert.equal(legacyForgeInstall("forge install -e x; rsync -s a b"), "a");
  assert.equal(legacyForgeInstall('forge install --site "x"'), null);
  assert.equal(legacyForgeInstall("forge.cmd install -s x"), null);
});

// Issue #347: rule 4 reads the verb of each forge invocation. The forms the
// regex missed, the wrappers it already caught, and #327 decision 2 (variant
// B): quoted text that spells the command stays a match.
const TUNNELS: string[] = [
  "forge.cmd tunnel",
  "forge.exe tunnel",
  "npx @forge/cli tunnel",
  "npx @forge/cli@latest tunnel",
  "C:\\Users\\x\\AppData\\Roaming\\npm\\forge.cmd tunnel",
  "forge --verbose tunnel",
  "forge tunnel",
  "cd app && forge tunnel",
  "bash -c 'forge tunnel'",
  'pwsh -Command "forge tunnel"',
  'ssh example-host "cd app && forge tunnel"',
  "bash <<EOF\nforge tunnel\nEOF",
  'echo "forge tunnel"',
  "grep forge tunnel notes.md",
  'node broker.mts comment --body "do not run forge tunnel here"',
];

// The false positives measured in #347, and neighbours that never tunnel.
// Operator decision 3: oclif verbs are case-sensitive, so `forge TUNNEL` passes.
const NO_TUNNEL: string[] = [
  'gh issue comment 347 --body "rule 4 blocks forge tunnel, see #347"',
  "cat > note.md <<'EOF'\nRule 4 blocks `forge tunnel` now.\nEOF",
  `echo '{"text":"forge tunnel"}'`,
  "forge tunnels",
  "forgery tunnel",
  "cloudflared tunnel run",
  "forge TUNNEL",
  "forge deploy -e development",
];

test("a forge tunnel matches, also the forms the regex missed", () => {
  for (const command of TUNNELS) assert.equal(forgeTunnelVerdict(command), "match", command);
});

test("text that only mentions a tunnel, and other verbs, are none", () => {
  for (const command of NO_TUNNEL) assert.equal(forgeTunnelVerdict(command), "none", command);
});

test("an unparseable tunnel is uncertain, and the legacy regex of rule 4 decides it", () => {
  assert.equal(forgeTunnelVerdict('echo "see forge tunnel, #347'), "uncertain");
  assert.equal(forgeTunnelVerdict('forge tunnel "unterminated'), "match");
  assert.equal(forgeTunnelVerdict(undefined as never), "uncertain");
  assert.equal(legacyForgeTunnel('echo "see forge tunnel, #347'), true);
  assert.equal(legacyForgeTunnel('echo "see forge tunnel, #347"'), true);
  assert.equal(legacyForgeTunnel("forge.cmd tunnel"), false);
  assert.equal(legacyForgeTunnel("forge tunnels"), false);
});

test("forgeInvocations takes the next word that is not a flag as the verb", () => {
  const verbs = (command: string) => forgeInvocations(command.split(" ")).map(({ verb, at }) => `${verb}@${at}`);
  assert.deepEqual(verbs("forge --verbose deploy -e x"), ["deploy@2"]);
  assert.deepEqual(verbs("npx @forge/cli deploy && FORGE.EXE install"), ["deploy@2", "install@5"]);
  assert.deepEqual(verbs("forge forge deploy"), ["forge@1", "deploy@2"]);
  assert.deepEqual(verbs("forgery deploy"), []);
  assert.deepEqual(verbs("forge"), []);
});

// A seeded generator, so a failure names a reproducible input.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["forge", "forge.cmd", "@forge/cli", "deploy", "install", "tunnel", "list", "-e", "-eproduction", "--environment=",
  "production", "prod", "-s", "--site", "-s=", "x", " ", " ", "\n", "'", '"', "\\", "`", "$(", "(", ")", ";", "&&", "|",
  ">", "2>&1", "<<", "EOF", "--", "\r\n", "\t", "#", "ssh", "bash -c "];

test("fuzz: the verdicts are always one of three and never throw", () => {
  const next = random(328);
  for (let round = 0; round < 3000; round++) {
    let command = "";
    const length = Math.floor(next() * 24);
    for (let k = 0; k < length; k++) command += PIECES[Math.floor(next() * PIECES.length)];
    assert.ok(["match", "none", "uncertain"].includes(forgeDeployVerdict(command)), JSON.stringify(command));
    assert.ok(["match", "none", "uncertain"].includes(install(command)), JSON.stringify(command));
    assert.ok(["match", "none", "uncertain"].includes(forgeTunnelVerdict(command)), JSON.stringify(command));
  }
});

test("a long adversarial command stays linear", () => {
  const started = Date.now();
  forgeDeployVerdict(`${"forge deploy ".repeat(20000)}-e x`);
  forgeDeployVerdict(`forge ${"--verbose ".repeat(20000)}deploy`);
  forgeTunnelVerdict(`forge ${"--verbose ".repeat(20000)}tunnel`);
  forgeInstallVerdict(`${"forge install -s ".repeat(20000)}`);
  forgeInstallVerdict(`${"'a b' ".repeat(20000)}`);
  forgeDeployVerdict(`echo ${"$(".repeat(5000)}`);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
