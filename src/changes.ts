/**
 * Change entries — a plain, honest reading of the OpenSpec delta markers.
 *
 * Pure over the model. One entry per requirement that carries a delta. The
 * summary is mechanical prose: it names the requirement and states the delta and
 * nothing else — no magnitude, no reason, no judgement the marker cannot support.
 *
 * The before/after fields are filled only from what the model actually holds. An
 * OpenSpec change records the *new* text of an ADDED/MODIFIED requirement, so that
 * lands in `after`; it never records the prior text, so `before` stays undefined
 * and the summary says so rather than inventing a diff. REMOVED is the one
 * inversion: a `## REMOVED Requirements` block lists the text being deleted, which
 * is a genuinely-known *prior* state, so it lands in `before` with no `after`.
 */

import type { ChangeEntry, DeltaKind, SpecModel } from './types.js';

/** Emit order: additions, then edits, then renames, then deletions. */
const DELTA_RANK: Record<DeltaKind, number> = {
  ADDED: 0,
  MODIFIED: 1,
  RENAMED: 2,
  REMOVED: 3,
};

/** Mechanical, marker-only prose. Always quotes the requirement name. */
function summarise(name: string, delta: DeltaKind): string {
  const subject = `Requirement "${name}"`;
  switch (delta) {
    case 'ADDED':
      return `${subject} was ADDED; it is new, so there is no prior version to compare against.`;
    case 'MODIFIED':
      return `${subject} was MODIFIED; no prior text is recorded, so only the current text is shown, not a diff.`;
    case 'RENAMED':
      return `${subject} was RENAMED; any recorded FROM/TO names are shown in the text below.`;
    case 'REMOVED':
      return `${subject} was REMOVED; the text below is what the change deletes.`;
  }
}

/**
 * One ChangeEntry per delta-bearing requirement, ordered by delta kind then doc
 * path (stable within a doc). A model with no deltas returns `[]`.
 */
export function changeEntries(model: SpecModel): ChangeEntry[] {
  const rows: Array<{ entry: ChangeEntry; path: string; order: number }> = [];
  let order = 0;

  for (const doc of model.docs) {
    for (const req of doc.requirements) {
      if (!req.delta) continue;
      const delta = req.delta;
      const text = req.text.trim();
      const entry: ChangeEntry = {
        anchor: req.id,
        requirement: req.name,
        delta,
        summary: summarise(req.name, delta),
      };
      // REMOVED text is the known prior state; every other delta's text is the
      // new state. A 'before' is never synthesised — it is present only when the
      // model literally records the deleted text.
      if (delta === 'REMOVED') {
        if (text) entry.before = text;
      } else {
        entry.after = text || req.name;
      }
      rows.push({ entry, path: doc.path, order });
      order += 1;
    }
  }

  rows.sort(
    (a, b) =>
      DELTA_RANK[a.entry.delta] - DELTA_RANK[b.entry.delta] ||
      a.path.localeCompare(b.path) ||
      a.order - b.order
  );
  return rows.map((row) => row.entry);
}
