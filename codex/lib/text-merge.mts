function newlineFor(text: string): string {
  return String(text).includes("\r\n") ? "\r\n" : "\n";
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function setMarkedBlock(existing: string, startMarker: string, endMarker: string, body: string): string {
  const hasStart = existing.includes(startMarker);
  const hasEnd = existing.includes(endMarker);
  if (hasStart !== hasEnd) {
    throw new Error(`Refusing to update an incomplete managed block: ${startMarker}`);
  }
  if (hasStart) {
    const start = existing.indexOf(startMarker);
    const end = existing.indexOf(endMarker);
    const duplicateStart = existing.indexOf(startMarker, start + startMarker.length) !== -1;
    const duplicateEnd = existing.indexOf(endMarker, end + endMarker.length) !== -1;
    if (end < start || duplicateStart || duplicateEnd) {
      throw new Error(`Refusing to update an ambiguous managed block: ${startMarker}`);
    }
  }
  const newline = newlineFor(existing);
  const block = `${startMarker}${newline}${body.trim()}${newline}${endMarker}`;
  if (!hasStart) {
    return existing.trim() ? `${existing.trimEnd()}${newline}${newline}${block}${newline}` : `${block}${newline}`;
  }
  const pattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`);
  return existing.replace(pattern, block);
}

export function setTopLevelSetting(config: string, key: string, tomlValue: string): string {
  const newline = newlineFor(config);
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable === -1 ? lines.length : firstTable;
  const setting = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = 0; index < limit; index += 1) {
    if (setting.test(lines[index])) {
      lines[index] = `${key} = ${tomlValue}`;
      return lines.join(newline);
    }
  }
  return `${key} = ${tomlValue}${newline}${config}`;
}

export function enableHooks(config: string): string {
  const newline = newlineFor(config);
  const lines = config.split(/\r?\n/);
  const section = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  if (section === -1) {
    const prefix = config.trimEnd();
    return `${prefix}${prefix ? `${newline}${newline}` : ""}[features]${newline}hooks = true${newline}`;
  }
  let end = lines.length;
  for (let index = section + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  for (let index = section + 1; index < end; index += 1) {
    if (/^\s*hooks\s*=/.test(lines[index])) {
      lines[index] = "hooks = true";
      return lines.join(newline);
    }
  }
  lines.splice(section + 1, 0, "hooks = true");
  return lines.join(newline);
}
