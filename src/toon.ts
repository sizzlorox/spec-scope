/**
 * A small TOON (Token-Oriented Object Notation) encoder for the agent-facing
 * commands.
 *
 * spec-scope is an AXI — an interface an AI agent drives — so its read commands
 * (`explain`, `decisions`) hand back uniform arrays the agent parses on every
 * loop. JSON repeats every key on every row; TOON states the header once and
 * lists rows CSV-style, which is markedly cheaper in tokens for exactly this
 * shape. This encoder covers the shapes we emit — scalars, flat objects, arrays
 * of scalars, and arrays of uniform flat objects (the tabular win) — and falls
 * back to indented key/value form for anything nested.
 *
 * tradeoff: not a full TOON implementation. A value nested more than one level
 * (an object inside an array element) is JSON-encoded inline rather than given
 * its own TOON block. The agent read commands never produce that; if a future
 * one does, this degrades to correct-but-verbose rather than wrong.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const SEP = ',';

/** A scalar needs quoting when it could be misread as structure or whitespace. */
function needsQuote(s: string): boolean {
  return s === '' || /[",:\n\r]/.test(s) || s !== s.trim();
}

function quote(s: string): string {
  return needsQuote(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isScalar(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || typeof v !== 'object';
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return quote(v);
  // Not a scalar for our shapes; encode defensively rather than "[object Object]".
  return quote(JSON.stringify(v));
}

/** True when every element is a flat object (all values scalar) sharing one key set. */
function isUniformTable(arr: unknown[]): arr is Array<Record<string, unknown>> {
  if (arr.length === 0) return false;
  const first = arr[0];
  if (isScalar(first) || Array.isArray(first)) return false;
  const keys = Object.keys(first).join('\u0000');
  return arr.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Object.values(row).every(isScalar) &&
      Object.keys(row).join('\u0000') === keys
  );
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

/** JSON fallback for a value too nested for this encoder's TOON subset. */
function inlineFallback(v: unknown): string {
  return quote(JSON.stringify(v));
}

function encodeArray(key: string, arr: unknown[], depth: number): string[] {
  const pad = indent(depth);
  if (arr.length === 0) return [`${pad}${key}[0]:`];

  if (arr.every(isScalar)) {
    return [`${pad}${key}[${arr.length}]: ${arr.map(scalar).join(SEP)}`];
  }

  const [firstRow] = arr;
  if (isUniformTable(arr) && firstRow) {
    const fields = Object.keys(firstRow);
    const lines = [`${pad}${key}[${arr.length}]{${fields.join(SEP)}}:`];
    for (const row of arr) {
      lines.push(`${pad}  ${fields.map((f) => scalar(row[f])).join(SEP)}`);
    }
    return lines;
  }

  // Mixed / nested array: one indented block per element.
  const lines = [`${pad}${key}[${arr.length}]:`];
  for (const el of arr) {
    if (isScalar(el)) lines.push(`${pad}  - ${scalar(el)}`);
    else lines.push(`${pad}  - ${inlineFallback(el)}`);
  }
  return lines;
}

function encodeObject(obj: Record<string, unknown>, depth: number): string[] {
  const pad = indent(depth);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(...encodeArray(key, value, depth));
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(...encodeObject(value as Record<string, unknown>, depth + 1));
    } else {
      lines.push(`${pad}${key}: ${scalar(value)}`);
    }
  }
  return lines;
}

/**
 * Encode `value` as TOON. A top-level array becomes a headed table; a top-level
 * object becomes key/value lines. Returns a string with no trailing newline.
 */
export function encodeToon(value: Json): string {
  if (Array.isArray(value)) {
    // An empty key yields a header of `[N]{…}:` with no name — the top-level table.
    return encodeArray('', value, 0).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return encodeObject(value, 0).join('\n');
  }
  return scalar(value);
}
