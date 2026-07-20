/**
 * Project root and flavor detection.
 *
 * spec-scope is usually invoked from somewhere inside a repo rather than at its
 * top, so detection walks upwards until it recognises a spec workflow. Getting
 * the root right matters more than getting the flavor right: every id in the
 * model is derived from a path relative to it, and a note written against
 * `openspec/specs/auth/spec.md` must still resolve tomorrow.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SpecFlavor } from './types.js';

export interface DetectResult {
  root: string;
  flavor: SpecFlavor;
  /** Absolute directories worth scanning for Markdown. Always non-empty. */
  specDirs: string[];
}

/**
 * Directories that never hold specs and are expensive to walk. Dot-directories
 * are also skipped generically by the walker (except `.specify/`); the named
 * entries here cover the non-dotted build outputs.
 */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '.spec-scope',
]);

/** How far above the starting directory detection is willing to look. */
const MAX_WALK_UP = 24;

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * True when `specs/` holds at least one `NNN-slug/spec.md`, the shape Spec Kit
 * creates per feature. Checked because `.specify/` is often gitignored, so a
 * cloned repo can carry the specs without the tooling directory.
 */
async function hasSpeckitFeature(specsDir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{3,}-/.test(entry.name)) continue;
    if (await isFile(path.join(specsDir, entry.name, 'spec.md'))) return true;
  }
  return false;
}

/** Keeps only the directories that exist, preserving the caller's order. */
async function existingDirs(candidates: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Walk up from `dir` looking for a recognisable spec project.
 *
 * OpenSpec is probed before Spec Kit because a repo migrating between the two
 * can carry both, and `openspec/` is the more specific signal.
 */
export async function detectProject(dir: string): Promise<DetectResult> {
  const start = path.resolve(dir);
  let current = start;

  for (let hop = 0; hop < MAX_WALK_UP; hop += 1) {
    const openspecDir = path.join(current, 'openspec');
    if (await isDirectory(openspecDir)) {
      return { root: current, flavor: 'openspec', specDirs: [openspecDir] };
    }

    const specifyDir = path.join(current, '.specify');
    const specsDir = path.join(current, 'specs');
    if ((await isDirectory(specifyDir)) || (await hasSpeckitFeature(specsDir))) {
      const specDirs = await existingDirs([specsDir, path.join(specifyDir, 'memory')]);
      return {
        root: current,
        flavor: 'speckit',
        specDirs: specDirs.length > 0 ? specDirs : [current],
      };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // tradeoff: an unrecognised project is scanned where the user pointed us,
  // not at the git root — walking up to a monorepo top and shallow-scanning it
  // finds READMEs, not specs. Upgrade path: honour an explicit --spec-dir flag.
  return { root: start, flavor: 'unknown', specDirs: [start] };
}
