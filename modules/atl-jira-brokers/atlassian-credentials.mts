// Shared, runtime-neutral parser for Atlassian service-account credential files.
// Runtime identity stays with each caller's credential environment variable;
// this module receives only the already-read text and never touches the host.
export interface AtlassianCredentials {
  clientId: string;
  clientSecret: string;
}

export class AtlassianCredentialError extends Error {}

function fail(message: string): never {
  throw new AtlassianCredentialError(message);
}

export function parseCredentialText(raw: unknown): AtlassianCredentials {
  const lines = String(raw).split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 2) fail("Credentials-Datei hat nicht genau zwei Werte.");
  const entries = lines.map((line) => {
    const colon = line.indexOf(":");
    if (colon < 1) fail("Credentials-Datei hat ein ungültiges Format.");
    const key = line.slice(0, colon).replace(/^\uFEFF/, "").trim();
    const value = line.slice(colon + 1).trim();
    if (!key || !value) fail("Credentials-Datei enthält einen leeren Wert.");
    return { key, value };
  });
  const secrets = entries.filter(({ key }) => /secret/i.test(key));
  const clients = entries.filter(({ key }) => !/secret/i.test(key));
  if (secrets.length !== 1 || clients.length !== 1) {
    fail("Credentials-Datei enthält nicht genau Client ID und Secret.");
  }
  return { clientId: clients[0].value, clientSecret: secrets[0].value };
}
