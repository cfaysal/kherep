export function setPluginEnabled(config: string, pluginId: string, enabled: boolean): string {
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const lines = config.split(/\r?\n/);
  const header = `[plugins.${JSON.stringify(pluginId)}]`;
  const headerIndexes = lines
    .map((line, index) => line.trim() === header ? index : -1)
    .filter((index) => index !== -1);
  if (headerIndexes.length > 1) {
    throw new Error(`Refusing to update duplicate TOML table: ${header}`);
  }
  if (!headerIndexes.length) {
    const prefix = config.trimEnd();
    const separator = prefix ? `${newline}${newline}` : "";
    return `${prefix}${separator}${header}${newline}enabled = ${enabled}${newline}`;
  }

  const headerIndex = headerIndexes[0];
  let sectionEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const enabledIndexes: number[] = [];
  for (let index = headerIndex + 1; index < sectionEnd; index += 1) {
    if (/^\s*enabled\s*=/.test(lines[index])) enabledIndexes.push(index);
  }
  if (enabledIndexes.length > 1) {
    throw new Error(`Refusing to update duplicate enabled settings in ${header}`);
  }
  if (enabledIndexes.length) {
    lines[enabledIndexes[0]] = `enabled = ${enabled}`;
  } else {
    lines.splice(headerIndex + 1, 0, `enabled = ${enabled}`);
  }
  return lines.join(newline);
}
