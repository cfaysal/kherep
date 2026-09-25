import { challengeMessage, fromBase64Url, toBase64Url, type AuthBody } from "../../protocol.mts";

// Ed25519 through WebCrypto (Secure Curves), supported for importKey and
// sign/verify in Workers: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
const ED25519 = { name: "Ed25519" };

async function importPublicKey(publicKey: string): Promise<CryptoKey | null> {
  try {
    const raw = fromBase64Url(publicKey);
    if (raw.length !== 32) return null;
    return await crypto.subtle.importKey("raw", raw, ED25519, false, ["verify"]);
  } catch {
    return null;
  }
}

export async function isEd25519PublicKey(publicKey: unknown): Promise<boolean> {
  return typeof publicKey === "string" && (await importPublicKey(publicKey)) !== null;
}

export async function verifyChallenge(publicKey: string, auth: AuthBody): Promise<boolean> {
  const key = await importPublicKey(publicKey);
  if (!key) return false;
  try {
    const signature = fromBase64Url(auth.signature);
    return await crypto.subtle.verify(ED25519, key, signature, challengeMessage(auth.nonce, auth.nodeId, auth.timestamp));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 16): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toBase64Url(new Uint8Array(digest));
}
