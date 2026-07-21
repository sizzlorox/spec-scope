/**
 * Explain work list — the diff between the spec and the review that tells the
 * in-loop agent what prose is missing or stale.
 *
 * Pure over the model, the review file and the notes. spec-scope writes nothing
 * itself; it hands back a to-do list, the agent generates the content (honestly
 * flagged with provenance), and `spec-scope apply` stores it. Staleness is decided
 * with the shared hashes in `./hash.js`, never a private one, so the writer and
 * this checker can never disagree about what a hash covers.
 */

import { docStructureSource, requirementSource, scenarioSource, specHash } from './hash.js';
import type { ExplainTask, Note, ReviewFile, SpecModel } from './types.js';

function key(anchor: string, kind: string): string {
  return `${anchor}\u0000${kind}`;
}

/** Every hint ends with this so the agent closes the staleness loop. */
const COPY_HASH = 'Copy this task’s specHash verbatim into the explanation you write.';

function summaryTask(
  anchor: string,
  name: string,
  reason: 'missing' | 'stale',
  hash: string
): ExplainTask {
  const hint =
    reason === 'missing'
      ? `Write a one- to two-sentence plain-language summary of requirement "${name}". Restate the requirement's own text (provenance grounded, cite it); where you read intent the text does not state, mark it inferred; if the intent is genuinely unstated, mark it unstated so it surfaces as an open question, never as a fact. ${COPY_HASH}`
      : `Requirement "${name}" changed since its summary was written. Rewrite the summary to match the current text and re-cite it (provenance grounded); mark any reading beyond the text inferred and any real gap unstated. ${COPY_HASH}`;
  return { kind: 'summary', anchor, anchorLabel: name, reason, specHash: hash, hint };
}

function narrationTask(
  anchor: string,
  label: string,
  scnName: string,
  reqName: string,
  reason: 'missing' | 'stale',
  hash: string
): ExplainTask {
  const hint =
    reason === 'missing'
      ? `Narrate scenario "${scnName}" of requirement "${reqName}" step by step in plain language. Ground each claim in the scenario's steps (provenance grounded, cite them); mark any inference inferred and any gap unstated. ${COPY_HASH}`
      : `Scenario "${scnName}" of requirement "${reqName}" changed since its narration was written. Rewrite it to match the current steps (provenance grounded); mark inference inferred and gaps unstated. ${COPY_HASH}`;
  return { kind: 'narration', anchor, anchorLabel: label, reason, specHash: hash, hint };
}

/**
 * The worthiness rubric + gate the agent applies when deciding whether to author a
 * diagram, and how. Shared verbatim by the missing and stale hints so both teach the
 * same rule — this text is the value of the diagram task, so it stays literal.
 */
const DIAGRAM_RUBRIC =
  'DEFAULT IS NO DIAGRAM — author one only for structure prose represents poorly. ' +
  'content signal -> type (first match): Data Model/entities+fields+cardinality -> er; ' +
  'an entity with enumerated statuses + transitions -> state; ' +
  'request/response across >=2 named participants -> sequence; ' +
  'a branching/decision process -> flowchart; module/component structure -> class. ' +
  'TWO ALTITUDES: consolidate aggregate structures into ONE diagram spanning many scenarios ' +
  '(one state machine per entity, one ER for the whole data model, one sequence per endpoint) — ' +
  'never one per scenario. ' +
  'Author each with anchor = this doc id, covers = the specific requirement/scenario ids it depicts, ' +
  'type, a one-line trigger (which signal fired), honest provenance, specHash copied from THIS task. ' +
  'If nothing warrants a diagram, record a diagramSkip {anchor: doc id, specHash: this task’s, reason} — ' +
  'that is the honest tracked "none", not silence.';

/** A per-document diagram task, pinning the agent to the doc's structural hash. */
function diagramTask(
  anchor: string,
  title: string,
  reason: 'missing' | 'stale',
  hash: string
): ExplainTask {
  const lead =
    reason === 'missing'
      ? `Review document "${title}" for diagram-worthy structure. `
      : `Document "${title}" changed structurally since its diagram(s) were authored — re-review it and update, replace, or skip. `;
  return {
    kind: 'diagram',
    anchor,
    anchorLabel: title,
    reason,
    specHash: hash,
    hint: `${lead}${DIAGRAM_RUBRIC}`,
  };
}

/**
 * The work list, in a deterministic order: per document, each requirement's
 * summary task then its scenarios' narration tasks; then a glossary task per
 * undefined term; then a decision task per resolved note without a decision; and
 * finally a diagram task per document whose structure has no matching authored
 * diagram or skip.
 */
export function explainWork(model: SpecModel, review: ReviewFile, notes: Note[]): ExplainTask[] {
  const tasks: ExplainTask[] = [];

  // anchor+kind -> the specHash the existing explanation was pinned to.
  const pinned = new Map<string, string>();
  for (const exp of review.explanations) {
    pinned.set(key(exp.anchor, exp.kind), exp.specHash);
  }

  for (const doc of model.docs) {
    for (const req of doc.requirements) {
      const want = specHash(
        requirementSource(
          req.name,
          req.text,
          req.scenarios.map((s) => s.name)
        )
      );
      const have = pinned.get(key(req.id, 'summary'));
      if (have === undefined) {
        tasks.push(summaryTask(req.id, req.name, 'missing', want));
      } else if (have !== want) {
        tasks.push(summaryTask(req.id, req.name, 'stale', want));
      }

      for (const scn of req.scenarios) {
        const scnWant = specHash(
          scenarioSource(
            scn.name,
            scn.steps.map((s) => s.text)
          )
        );
        const scnHave = pinned.get(key(scn.id, 'narration'));
        const label = `${req.name} / ${scn.name}`;
        if (scnHave === undefined) {
          tasks.push(narrationTask(scn.id, label, scn.name, req.name, 'missing', scnWant));
        } else if (scnHave !== scnWant) {
          tasks.push(narrationTask(scn.id, label, scn.name, req.name, 'stale', scnWant));
        }
      }
    }
  }

  for (const term of review.glossary) {
    if (term.defined) continue;
    tasks.push({
      kind: 'glossary',
      anchor: term.term,
      anchorLabel: term.term,
      reason: 'missing',
      specHash: '',
      hint: `Define the term "${term.term}" as this spec uses it. Ground the definition in the text that uses the term (provenance grounded, with sources); if the spec never actually defines it, mark the definition unstated so it stays an open question instead of a guess.`,
    });
  }

  const decidedNotes = new Set<string>();
  for (const decision of review.decisions) {
    if (decision.threadNoteId) decidedNotes.add(decision.threadNoteId);
  }
  for (const note of notes) {
    if (note.status !== 'resolved') continue;
    if (decidedNotes.has(note.id)) continue;
    tasks.push({
      kind: 'decision',
      anchor: note.id,
      anchorLabel: note.anchorLabel,
      reason: 'missing',
      specHash: '',
      hint: `Distill the resolved discussion on "${note.anchorLabel}" into a decision: the context, the options weighed, the choice, its tradeoffs and its consequence. Ground every part in the thread (provenance grounded, cite the note "${note.id}"); never invent a rationale the thread does not contain — mark anything unsupported unstated.`,
    });
  }

  // Per-document diagram tasks, after every summary/narration/glossary/decision task.
  // A diagram (or an honest "no diagram" skip) is pinned to the doc's whole structural
  // text; an AuthoredDiagram or DiagramSkip anchored on the doc at the matching hash
  // closes the task, a different hash re-opens it as stale, and none at all is missing.
  const diagramHashes = new Map<string, Set<string>>();
  const remember = (anchor: string, hash: string): void => {
    const set = diagramHashes.get(anchor) ?? new Set<string>();
    set.add(hash);
    diagramHashes.set(anchor, set);
  };
  for (const dgm of review.diagrams) remember(dgm.anchor, dgm.specHash);
  for (const skip of review.diagramSkips) remember(skip.anchor, skip.specHash);

  for (const doc of model.docs) {
    if (doc.requirements.length === 0) continue;
    const want = specHash(docStructureSource(doc));
    const have = diagramHashes.get(doc.id);
    if (have?.has(want)) continue;
    tasks.push(diagramTask(doc.id, doc.title, have ? 'stale' : 'missing', want));
  }

  return tasks;
}
