/** Pure multi-section INI layer for smart-one.cfg. String values only, no IO.
 * Section names are disk ids and stay case-sensitive: CustomMerge.php compares
 * them with PHP `==`. */
const SECTION_HEADER_RE = /^\[([^\]]*)\]$/;
const LINE_TERMINATOR_RE = /(\r\n|\n)$/;
const KEY_VALUE_RE = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*?)(\s*)$/;

function splitPreservingTerminators(text: string): string[] {
  return text.split(/(?<=\n)/);
}

function stripTerminator(line: string): string {
  return line.replace(LINE_TERMINATOR_RE, '');
}

function sectionNameOf(strippedLine: string): string | null {
  const match = SECTION_HEADER_RE.exec(strippedLine.trim());
  return match ? (match[1] ?? '') : null;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Header line index, and the index of the next header (or EOF). */
export interface SectionSpan {
  readonly name: string;
  readonly headerIndex: number;
  readonly endIndex: number;
}

/** Every section span, in file order. Content before the first header belongs to none. */
export function indexSections(lines: readonly string[]): readonly SectionSpan[] {
  const headers: { readonly name: string; readonly headerIndex: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const name = sectionNameOf(stripTerminator(lines[i]!));
    if (name !== null) headers.push({ name, headerIndex: i });
  }
  return headers.map((header, position) => ({
    name: header.name,
    headerIndex: header.headerIndex,
    endIndex: headers[position + 1]?.headerIndex ?? lines.length,
  }));
}

/** Whether any section survives. Pure, so reset can decide the unlink from post-removal text. */
export function hasAnySection(text: string): boolean {
  return indexSections(splitPreservingTerminators(text)).length > 0;
}

/** Section names verbatim, in file order, de-duplicated first-wins. */
export function listSectionNames(text: string): readonly string[] {
  const names = new Set<string>();
  for (const span of indexSections(splitPreservingTerminators(text))) {
    names.add(span.name);
  }
  return [...names];
}

function findSpan(lines: readonly string[], section: string): SectionSpan | undefined {
  return indexSections(lines).find((span) => span.name === section);
}

/** Every key of one section, unquoted. `null` means NO SUCH SECTION; a keyless
 * section yields an empty map. Duplicate keys resolve last-wins. Unmodeled keys
 * are returned too. */
export function readSectionValues(
  text: string,
  section: string,
): ReadonlyMap<string, string> | null {
  const lines = splitPreservingTerminators(text);
  const span = findSpan(lines, section);
  if (!span) return null;

  const values = new Map<string, string>();
  for (let i = span.headerIndex + 1; i < span.endIndex; i += 1) {
    const match = KEY_VALUE_RE.exec(stripTerminator(lines[i]!));
    if (!match) continue;
    values.set(match[2]!, stripQuotes(match[4] ?? '').trim());
  }
  return values;
}

function terminatorOf(line: string): string {
  const match = LINE_TERMINATOR_RE.exec(line);
  return match ? match[1]! : '';
}

function formatValue(rawValue: string, newValue: string): string {
  if (rawValue.length >= 2) {
    const first = rawValue[0];
    const last = rawValue[rawValue.length - 1];
    if (first === '"' && last === '"') return `"${newValue}"`;
    if (first === "'" && last === "'") return `'${newValue}'`;
  }
  return newValue;
}

function lastNonBlankLineIndex(
  lines: readonly string[],
  headerIndex: number,
  endIndex: number,
): number {
  for (let i = endIndex - 1; i > headerIndex; i -= 1) {
    if (stripTerminator(lines[i]!).trim() !== '') return i;
  }
  return headerIndex;
}

function dominantTerminator(lines: readonly string[], start: number, end: number): string {
  let crlf = 0;
  let lf = 0;
  for (let i = start; i < end; i += 1) {
    const terminator = terminatorOf(lines[i]!);
    if (terminator === '\r\n') crlf += 1;
    else if (terminator === '\n') lf += 1;
  }
  if (crlf === 0 && lf === 0) return '';
  return crlf > lf ? '\r\n' : '\n';
}

function appendNewSection(
  text: string,
  section: string,
  values: ReadonlyMap<string, string | null>,
): string {
  const entries = [...values.entries()].filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  if (entries.length === 0) return text;

  const lines = splitPreservingTerminators(text);
  const eol = dominantTerminator(lines, 0, lines.length) || '\n';
  const prefix = text.length > 0 && !LINE_TERMINATOR_RE.test(text) ? `${text}${eol}` : text;
  const body = entries.map(([key, value]) => `${key}="${value}"${eol}`).join('');
  return `${prefix}[${section}]${eol}${body}`;
}

/** Writes `values` into one section. A `null` value DELETES the key's line.
 * Rewrites every occurrence of a listed key; appends a missing one inside the
 * span; creates an absent section at EOF; an absent section with all-null values
 * is a no-op. Everything else stays byte-identical. */
export function patchSection(
  text: string,
  section: string,
  values: ReadonlyMap<string, string | null>,
): string {
  if (values.size === 0) return text;

  const lines = splitPreservingTerminators(text);
  const span = findSpan(lines, section);
  if (!span) return appendNewSection(text, section, values);

  const found = new Set<string>();
  const removals: number[] = [];

  for (let i = span.headerIndex + 1; i < span.endIndex; i += 1) {
    const line = lines[i]!;
    const match = KEY_VALUE_RE.exec(stripTerminator(line));
    if (!match) continue;
    const key = match[2]!;
    if (!values.has(key)) continue;

    found.add(key);
    const newValue = values.get(key) ?? null;
    if (newValue === null) {
      removals.push(i);
      continue;
    }

    const indent = match[1] ?? '';
    const eq = match[3] ?? '';
    const trailing = match[5] ?? '';
    const formatted = formatValue(match[4] ?? '', newValue);
    lines[i] = `${indent}${key}${eq}${formatted}${trailing}${terminatorOf(line)}`;
  }

  for (const index of removals.sort((a, b) => b - a)) {
    lines.splice(index, 1);
  }

  const missing = [...values.entries()].filter(
    (entry): entry is [string, string] => entry[1] !== null && !found.has(entry[0]),
  );
  if (missing.length > 0) {
    const rebounds = findSpan(lines, section);
    const from = rebounds?.headerIndex ?? span.headerIndex;
    const to = rebounds?.endIndex ?? span.endIndex;
    const insertAt = lastNonBlankLineIndex(lines, from, to);
    const eol =
      dominantTerminator(lines, from, to) || dominantTerminator(lines, 0, lines.length) || '\n';
    lines.splice(insertAt + 1, 0, ...missing.map(([key, value]) => `${key}="${value}"${eol}`));
  }

  return lines.join('');
}

/** Removes the header, its keys and any trailing blank line inside the span,
 * unmodeled keys included. Unchanged when the section is absent. */
export function removeSection(text: string, section: string): string {
  const lines = splitPreservingTerminators(text);
  const span = findSpan(lines, section);
  if (!span) return text;

  lines.splice(span.headerIndex, span.endIndex - span.headerIndex);
  return lines.join('');
}
