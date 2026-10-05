#!/usr/bin/env node
/**
 * Test harness for deploy-guard.js
 * Spawns the hook with a crafted stdin JSON payload, asserts exit code
 * (2 = block, 0 = allow) and, on block, the stderr content.
 * Node-native, no external framework (matches clq-accept-gate.test.js style).
 * Run: node deploy-guard.test.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "deploy-guard.js");

let pass = 0;
let fail = 0;

// Runs the hook with a Bash command (or raw payload) and returns
// { blocked, stderr }. blocked === true when exit code is 2.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-guard-test-"));
let transcriptCounter = 0;

function runHook(command, toolName, userText) {
  const payload = {
    tool_name: toolName || "Bash",
    tool_input: { command },
  };
  if (userText !== undefined) {
    const transcript = path.join(TMP, `transcript-${transcriptCounter++}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: userText }] } }) + "\n");
    payload.transcript_path = transcript;
  }
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { blocked: res.status === 2, stderr: res.stderr || "" };
}

// expectBlock: true => exit 2. stderrNeedle: optional substring required on block.
function check(name, command, expectBlock, stderrNeedle, userText) {
  const { blocked, stderr } = runHook(command, undefined, userText);
  let ok = blocked === expectBlock;
  if (ok && expectBlock && stderrNeedle) ok = stderr.includes(stderrNeedle);
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"} | ${name} | expected ${expectBlock ? "BLOCK" : "ALLOW"}, got ${blocked ? "BLOCK" : "ALLOW"}`
  );
}

// ---- Rule A: git force-push (SHOULD BLOCK) ----
check("git push --force", "git push --force", true, "force-push blocked");
check("git push -f origin main", "git push -f origin main", true, "force-push blocked");
check("git push --force-with-lease origin feature", "git push --force-with-lease origin feature", true, "force-push blocked");
check("git push origin main --force (flag last)", "git push origin main --force", true, "force-push blocked");

// ---- Rule A: benign git push (SHOULD ALLOW) ----
check("git push (bare)", "git push", false);
check("git push origin main", "git push origin main", false);
check("git push --set-upstream origin x", "git push --set-upstream origin x", false);
check("git push -u origin x", "git push -u origin x", false);
check("git push --tags", "git push --tags", false);
check("git push --follow-tags", "git push --follow-tags", false);

// ---- Rule A: bypass token (SHOULD ALLOW) ----
check("git push --force WITH auth token", "KHEREP_DEPLOY_AUTH=approved git push --force origin main", false);

// ---- Rule B: kubectl apply (SHOULD BLOCK) ----
check("kubectl apply -f deploy.yaml", "kubectl apply -f deploy.yaml", true, "kubectl apply blocked");
check("ssh-wrapped kubectl apply -f -", 'ssh example-host "kubectl apply -f -"', true, "kubectl apply blocked");
check("kubectl -n kherep apply -f x.yaml", "kubectl -n kherep apply -f x.yaml", true, "kubectl apply blocked");

// ---- Rule B: benign kubectl (SHOULD ALLOW) ----
check("kubectl get pods", "kubectl get pods", false);
check("kubectl -n kherep logs x", "kubectl -n kherep logs x", false);
check("kubectl describe", "kubectl describe pod x", false);
check("kubectl exec", "kubectl exec -it x -- sh", false);
check("kubectl cp", "kubectl cp x y", false);
check("ssh-wrapped kubectl get pods", 'ssh example-host "kubectl -n kherep get pods"', false);

// ---- Rule B: benign commands CONTAINING "apply" substring (SHOULD ALLOW) ----
// The greedy-regex false-positives the T2 review flagged. With the old
// /kubectl[\s\S]*apply/ these were wrongly blocked; the anchored regex allows them.
check("kubectl get pod apply-config", "kubectl get pod apply-config", false);
check("kubectl describe pod nginx-apply-xyz", "kubectl describe pod nginx-apply-xyz", false);
check("kubectl logs x | grep apply", "kubectl logs x | grep apply", false);
check("kubectl get cm -o yaml > apply.yaml", "kubectl get cm -o yaml > apply.yaml", false);
check("ssh-wrapped kubectl get deploy apply-foo", 'ssh example-host "kubectl -n kherep get deploy apply-foo"', false);

// ---- Rule B: bypass token (SHOULD ALLOW) ----
check("kubectl apply WITH auth token", "KHEREP_DEPLOY_AUTH=approved kubectl apply -f deploy.yaml", false);

// ---- Explicit standing exception: own cluster + namespace only ----
check("remote cluster apply still needs approval", 'ssh example-host "kubectl -n app apply -f deploy.yaml"', true, "kubectl apply blocked");

// ---- Rule C: destructive kubectl verbs, OP-1045 (SHOULD BLOCK) ----
// Blocked on every host and namespace, our own included. That IS the point:
// OP-951's acceptance criterion is that a delete in ns kherep on example-host is refused.
check("kubectl delete", "kubectl delete deployment/x", true, "destructive kubectl verb blocked");
check("OP-951 gegentest, ssh-wrapped delete in own namespace",
  'ssh example-host "kubectl -n kherep delete deployment/does-not-exist-kherep-guardtest --dry-run=client --ignore-not-found"',
  true, "destructive kubectl verb blocked");
check("kubectl scale without the ssh example-host route", "kubectl -n kherep scale deployment/x --replicas=0", true, "kubectl scale blocked");
check("kubectl drain", "kubectl drain example-host --ignore-daemonsets", true, "destructive kubectl verb blocked");
check("kubectl cordon", "kubectl cordon example-host", true, "destructive kubectl verb blocked");
check("kubectl uncordon", "kubectl uncordon example-host", true, "destructive kubectl verb blocked");
check("kubectl taint", "kubectl taint nodes example-host key=value:NoSchedule", true, "destructive kubectl verb blocked");
check("kubectl replace", "kubectl replace -f deploy.yaml", true, "destructive kubectl verb blocked");
check("kubectl edit", "kubectl edit deployment/x", true, "destructive kubectl verb blocked");
check("kubectl patch", "kubectl -n kherep patch deployment/x -p {}", true, "destructive kubectl verb blocked");
check("kubectl rollout undo", "kubectl -n kherep rollout undo deployment/x", true, "destructive kubectl verb blocked");

// ---- Rule C: the allowed neighbours (SHOULD ALLOW) ----
// rollout restart is the Director-approved routine operation from OP-951.
check("rollout restart, the approved case", "kubectl -n kherep rollout restart deployment/pgadmin", false);
check("rollout restart, ssh-wrapped", 'ssh example-host "kubectl -n kherep rollout restart statefulset confluence-test"', false);
check("kubectl get is read-only", "kubectl -n kherep get deployments", false);

// ---- Rule C: verbs as free substrings must NOT match (SHOULD ALLOW) ----
check("resource named delete-me", "kubectl get pod delete-me", false);
check("logs piped through grep delete", "kubectl logs x | grep delete", false);
check("redirect into patch.yaml", "kubectl get cm -o yaml > patch.yaml", false);
check("pod named scale-abc", "kubectl describe pod scale-abc", false);
check("ssh-wrapped get of a deploy named edit-config", 'ssh example-host "kubectl -n kherep get deploy edit-config"', false);

// ---- Rule C: bypass is the INLINE token only ----
check("kubectl delete WITH inline auth token", "KHEREP_DEPLOY_AUTH=approved kubectl delete deployment/x", false);
// A spoken production-deploy approval authorizes deploys, never a cluster delete.
check("kubectl delete despite spoken prod approval", "kubectl delete deployment/x", true,
  "destructive kubectl verb blocked", "Production deploy ist hiermit freigegeben");

// ---- Rule C-scale: standing exception for the on-demand DC workloads ----
check("remote scale has no pre-approved route",
  'ssh example-host "kubectl -n app scale statefulset service-test --replicas=2"', true, "kubectl scale blocked");
check("scale in a foreign namespace on our host",
  'ssh example-host "kubectl -n kunde scale deployment x --replicas=0"', true, "kubectl scale blocked");
check("scale on a foreign host in our namespace",
  'ssh kundenhost "kubectl -n kherep scale deployment x --replicas=0"', true, "kubectl scale blocked");
check("equals-form namespace is NOT the standing exception",
  'ssh example-host "kubectl --namespace=kherep scale statefulset jira-test --replicas=2"', true, "kubectl scale blocked");
check("scale anywhere WITH the inline token",
  "KHEREP_DEPLOY_AUTH=approved kubectl -n kunde scale deployment x --replicas=0", false);
check("delete keeps NO exception, not even on the approved route",
  'ssh example-host "kubectl -n kherep delete deployment/x"', true, "destructive kubectl verb blocked");

// ---- Rule E: destructive helm verbs (SHOULD BLOCK) ----
check("helm uninstall", 'ssh example-host "helm uninstall jira-test --namespace kherep"', true, "destructive helm verb blocked");
check("helm delete", "helm delete jira-test", true, "destructive helm verb blocked");
check("helm rollback", "helm -n kherep rollback jira-test 3", true, "destructive helm verb blocked");
check("helm uninstall WITH the inline token",
  "KHEREP_DEPLOY_AUTH=approved helm uninstall jira-test --namespace kherep", false);

// ---- Rule E: the routine helm path stays open (SHOULD ALLOW) ----
check("helm upgrade with the on-demand replica switch",
  'ssh example-host "helm upgrade jira-test atlassian-data-center/jira --version 2.0.14 -n kherep -f values.yaml --set replicaCount=1"', false);
check("helm upgrade --install", "helm upgrade --install confluence-test atlassian-data-center/confluence -n kherep -f values.yaml", false);
check("helm list", "helm list -n kherep", false);
check("helm status", "helm status jira-test -n kherep", false);
check("release named uninstall-test is not a verb", "helm status uninstall-test -n kherep", false);

// ---- Rule C: head-anchor edge cases, measured false negatives 2026-08-30 ----
check("windows binary name", "kubectl.exe delete pod/x", true, "destructive kubectl verb blocked");
check("windows binary name, apply rule still holds", "kubectl.exe apply -f x.yaml", true, "kubectl apply blocked");
check("double-quoted flag value with a space",
  'kubectl --context "my cluster" delete pod/x', true, "destructive kubectl verb blocked");
check("single-quoted flag value with a space",
  "kubectl --context 'my cluster' delete pod/x", true, "destructive kubectl verb blocked");
check("quoted flag value does not swallow a read-only verb",
  'kubectl --context "my cluster" get pods', false);

// ---- Rule D: the token only authorizes where a shell assignment can sit ----
// Measured false authorization on 2026-08-30: a heredoc that merely documented
// the token disarmed every rule for that entire call.
check("token in a trailing comment does not authorize",
  "kubectl delete deployment/x # KHEREP_DEPLOY_AUTH=approved", true, "destructive kubectl verb blocked");
check("token inside quoted prose does not authorize",
  'echo "bypass with KHEREP_DEPLOY_AUTH=approved" && kubectl delete deployment/x', true, "destructive kubectl verb blocked");
check("token documented in a heredoc does not authorize the payload",
  'cat > note.txt <<EOF\nBypass ist der Token KHEREP_DEPLOY_AUTH=approved.\nEOF\nssh example-host "kubectl -n kherep delete deployment/x"',
  true, "destructive kubectl verb blocked");
check("token as leading assignment authorizes",
  "KHEREP_DEPLOY_AUTH=approved kubectl delete deployment/x", false);
check("token after && authorizes",
  "cd app && KHEREP_DEPLOY_AUTH=approved npm run deploy:jira:prod", false);
check("token after ; authorizes",
  "echo start; KHEREP_DEPLOY_AUTH=approved forge deploy -e production", false);

// ---- Regression: existing guard #1 still blocks (forge deploy prod) ----
check("forge deploy -e production (existing guard)", "forge deploy -e production", true, "forge deploy --environment production blocked");

// ---- Regression: existing benign forge command still allowed ----
check("forge deploy -e development (allow)", "forge deploy -e development", false);

// ---- Equals-form environment flags (previously missed by \s+-only regex) ----
check("forge deploy --environment=production", "forge deploy --environment=production", true, "forge deploy --environment production blocked");
check("forge deploy -e=production", "forge deploy -e=production", true, "forge deploy --environment production blocked");
check("forge deploy --environment=production WITH auth token", "KHEREP_DEPLOY_AUTH=approved forge deploy --environment=production", false);
check("forge deploy --environment=development (allow)", "forge deploy --environment=development", false);

// ---- Production package-script wrappers (the previous guard bypass) ----
check("npm Forge prod wrapper", "npm run deploy:jira:prod", true, "production deploy wrapper blocked");
check("npm nested Forge prod wrapper", "cd app && npm run deploy:confluence:prod", true, "production deploy wrapper blocked");
check("pnpm prod wrapper", "pnpm run deploy:prod", true, "production deploy wrapper blocked");
check("yarn production wrapper", "yarn deploy:jira:production", true, "production deploy wrapper blocked");
check("prod-first wrapper", "npm run production:deploy", true, "production deploy wrapper blocked");
check("development wrapper", "npm run deploy:jira:dev", false);
check("build production bundle is not deploy", "npm run build:production", false);
check("npm prod wrapper WITH auth token", "KHEREP_DEPLOY_AUTH=approved npm run deploy:jira:prod", false);
check("npm prod wrapper with explicit user approval", "npm run deploy:jira:prod", false, undefined, "Bitte deploye Jira jetzt auf production");
check("direct Forge prod with explicit user approval", "forge deploy -e production", false, undefined, "Production deploy ist hiermit freigegeben");
check("negative user instruction never authorizes", "npm run deploy:jira:prod", true, "production deploy wrapper blocked", "Bitte nicht auf production deployen");
check("development request does not authorize production", "npm run deploy:jira:prod", true, "production deploy wrapper blocked", "Bitte auf development deployen");

// ---- Forge install site parsing ----
check("named site long flag", "forge install --site example.atlassian.net", true, "install on site");
check("named site short flag", "forge install -s example.atlassian.net", true, "install on site");
check("named site with auth", "KHEREP_DEPLOY_AUTH=approved forge install --site example.atlassian.net", false);

// ---- Fail-safe: non-Bash tool and malformed stdin allow ----
(function nonBash() {
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Read", tool_input: { command: "git push --force" } }),
    encoding: "utf8",
  });
  const ok = res.status === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | non-Bash tool (Read) | expected ALLOW, got ${res.status === 2 ? "BLOCK" : "ALLOW"}`);
})();

(function malformed() {
  const res = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  const ok = res.status === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | malformed stdin | expected ALLOW, got ${res.status === 2 ? "BLOCK" : "ALLOW"}`);
})();

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
