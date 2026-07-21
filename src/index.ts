/**
 * Public library surface.
 *
 * Everything here is what a programmatic consumer needs to read a spec project,
 * derive diagrams, drive the discussion loop and produce the tech doc. Internal
 * helpers (detection, parsing internals, vendor resolution) stay unexported so
 * they remain free to change.
 */

export type * from './types.js';

export {
  blastDiagram,
  generateDiagrams,
  requirementHeatMap,
  validateAuthoredMermaid,
} from './diagram.js';
export type { DiagramValidation } from './diagram.js';
export { exportTechDoc, renderTechDoc } from './export.js';
export type { ExportOptions } from './export.js';
export { docStructureSource, requirementSource, scenarioSource, specHash } from './hash.js';
export { NoteStore } from './notes.js';
export { parseProject } from './parse.js';
export { blastRadius } from './blast.js';
export { changeEntries } from './changes.js';
export { explainWork } from './explainwork.js';
export { ReviewStore } from './review.js';
export { startServer } from './server.js';
export type { ServerHandle } from './server.js';
