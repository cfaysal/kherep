import { isNodeFacts, isRuntimeList } from "../../protocol.mts";
import { isEd25519PublicKey } from "./crypto.mts";
import { registryStub, type Env } from "./env.mts";
import { fail, json, readJsonObject } from "./http.mts";

// POST /node/enroll: exchange a one-time enrollment code for a nodeId bound to
// the node's Ed25519 public key. The code is the only credential; it is single
// use and short-lived, so no long-lived bootstrap secret exists.
export async function handleEnroll(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method not allowed");
  const body = await readJsonObject(request);
  if (!body) return fail(400, "invalid body");
  const { code, publicKey, name, facts, runtimes } = body;
  if (typeof code !== "string" || code.length < 16 || code.length > 128) return fail(400, "invalid code");
  if (typeof name !== "string" || !/^[\w.-]{1,64}$/.test(name)) return fail(400, "invalid name");
  if (!isNodeFacts(facts)) return fail(400, "invalid facts");
  const runtimeList = runtimes ?? [];
  if (!isRuntimeList(runtimeList)) return fail(400, "invalid runtimes");
  if (!(await isEd25519PublicKey(publicKey))) return fail(400, "invalid public key");

  const result = await registryStub(env).redeemEnrollment({ code, publicKey: publicKey as string, name, facts, runtimes: runtimeList });
  if (!result.ok) return fail(403, result.reason);
  return json({ nodeId: result.nodeId }, 201);
}
