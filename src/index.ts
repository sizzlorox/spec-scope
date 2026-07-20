/**
 * Public library surface.
 *
 * Everything here is what a programmatic consumer needs to read a spec project,
 * derive diagrams, drive the discussion loop and produce the tech doc. Internal
 * helpers (detection, parsing internals, vendor resolution) stay unexported so
 * they remain free to change.
 */

export type * from './types.js';

export { generateDiagrams } from './diagram.js';
export { exportTechDoc, renderTechDoc } from './export.js';
export type { ExportOptions } from './export.js';
export { NoteStore } from './notes.js';
export { parseProject } from './parse.js';
export { startServer } from './server.js';
export type { ServerHandle } from './server.js';
