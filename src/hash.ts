/**
 * Content hashing for the review layer.
 *
 * An explanation records the hash of the spec text it explains. When the text
 * changes, the hash stops matching and the UI marks the explanation stale
 * instead of showing an out-of-date paraphrase as current. Whitespace is
 * normalised first so a trivial reflow of the same words does not invalidate a
 * still-correct explanation.
 */

import { createHash } from 'node:crypto';
import type { SpecDoc } from './types.js';

/** Stable 16-hex-char digest of `text`, insensitive to whitespace changes. */
export function specHash(text: string): string {
  const normalised = text.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/**
 * The text a requirement's summary is pinned to: its name plus prose plus each
 * scenario name. Scenario narration pins to the scenario's own steps. Keeping
 * this in one place means the writer (`explain`) and the reader (staleness
 * check) can never disagree about what a hash covers.
 */
export function requirementSource(name: string, text: string, scenarioNames: string[]): string {
  return [name, text, ...scenarioNames].join('\n');
}

export function scenarioSource(name: string, stepTexts: string[]): string {
  return [name, ...stepTexts].join('\n');
}

/**
 * The structural text an authored diagram (or a "no diagram" skip) is pinned to:
 * every requirement name + prose, and every scenario name + step, across the doc.
 * A diagram depicts a document's structure, so it goes stale when that structure
 * changes — the same staleness discipline the explanations use, at doc altitude.
 */
export function docStructureSource(doc: SpecDoc): string {
  const parts: string[] = [];
  for (const req of doc.requirements) {
    parts.push(req.name, req.text);
    for (const scn of req.scenarios) {
      parts.push(scn.name, ...scn.steps.map((s) => s.text));
    }
  }
  return parts.join('\n');
}
