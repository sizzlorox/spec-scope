/**
 * Stable identifiers.
 *
 * Ids are derived from human-readable names rather than file offsets so a note
 * written today still points at the right requirement after the spec is
 * reordered or reworded around it.
 */

/** Lowercase, dash-separated, ASCII-safe slug. Never empty. */
export function slug(input: string): string {
  const out = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

export function docId(relPath: string): string {
  return `doc:${slug(relPath)}`;
}

export function groupId(relPath: string): string {
  return `group:${slug(relPath)}`;
}

export function requirementId(parentDocId: string, name: string): string {
  return `${parentDocId}/req:${slug(name)}`;
}

export function scenarioId(parentRequirementId: string, name: string): string {
  return `${parentRequirementId}/scn:${slug(name)}`;
}

export function taskId(parentDocId: string, index: number): string {
  return `${parentDocId}/task:${index}`;
}

export function diagramId(anchor: string, kind: string): string {
  return `dgm:${kind}:${slug(anchor)}`;
}

/**
 * Mermaid node ids must be alphanumeric-ish to avoid clashing with the syntax.
 * Collisions are broken by an ordinal supplied by the caller.
 */
export function mermaidNodeId(prefix: string, ordinal: number): string {
  return `${prefix}${ordinal}`;
}

/**
 * Short, sortable, collision-resistant id for notes and replies.
 * Timestamp prefix keeps them in creation order when listed lexically.
 */
export function newId(prefix: string, now: number, random: () => number = Math.random): string {
  const stamp = now.toString(36).padStart(8, '0');
  const rand = Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}_${stamp}${rand}`;
}
