import { command } from "./parity-config.mts";

// Test fixture, issue #503. Every installer before the stable entry point named
// the source of the Control Plane hooks in their commands. Given a rendered TOML
// text in the stable form, this returns the bytes such an installer wrote from
// source root `root`: `"<entry>" "<name>"` becomes `"<root>/modules/control-plane/node/<name>-hook.mts"`,
// in the separator of `root`. control-plane-stable-hook.test.mts checks it
// against the renderer of the last release that wrote that form.
const STABLE = /\\"(?:[^"\\]|\\\\)*?codex-control-plane-hook\.mts\\" \\"(deliver|attribution)\\"/g;

export function legacyForm(text: string, root: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return text.replace(STABLE, (_match, name: string) => {
    const spelled = JSON.stringify(command([root, "modules", "control-plane", "node", `${name}-hook.mts`].join(sep))).slice(3, -3);
    return `\\"${spelled}\\"`;
  });
}

// The commands of a rendered TOML text that name `fragment`, decoded.
export function commandsNaming(config: string, fragment: string): string[] {
  return [...config.matchAll(/^command = (".*")$/gm)].map((match) => JSON.parse(match[1]) as string)
    .filter((value) => value.includes(fragment));
}
