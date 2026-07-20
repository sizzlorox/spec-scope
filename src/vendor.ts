/**
 * Locates the browser libraries we ship inside the generated HTML.
 *
 * The export is a single self-contained file and the server runs offline, so
 * mermaid and marked are inlined rather than pulled from a CDN. Paths are
 * resolved through the module resolver instead of being hardcoded, so the
 * package keeps working under pnpm/yarn layouts and from a global install.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

export type VendorAsset = 'mermaid' | 'marked';

/** Package subpaths, kept in one place so the two lookups cannot drift. */
const SPECIFIERS: Record<VendorAsset, string> = {
  mermaid: 'mermaid/dist/mermaid.min.js',
  marked: 'marked/marked.min.js',
};

const requireFromHere = createRequire(import.meta.url);

/** mermaid is ~3.5MB and every export re-reads it; one read per process is plenty. */
const cache = new Map<VendorAsset, string>();

/**
 * Absolute path to a vendored asset.
 *
 * Throws rather than returning a guess: a missing file here means a broken
 * install, and failing loudly beats emitting an HTML file with a dead script.
 */
export function vendorPath(name: VendorAsset): string {
  const specifier = SPECIFIERS[name];
  if (specifier === undefined) {
    throw new Error(
      `Unknown vendor asset '${name}'. Expected one of: ${Object.keys(SPECIFIERS).join(', ')}.`
    );
  }
  try {
    return requireFromHere.resolve(specifier);
  } catch (cause) {
    throw new Error(
      `Could not resolve the vendored asset '${name}' ('${specifier}'). ` +
        'This usually means dependencies are missing or partially installed — ' +
        'reinstall dependencies (for example `npm install`) and try again.',
      { cause }
    );
  }
}

/** Reads a vendored asset as utf8, memoising the result for the process lifetime. */
export async function readVendor(name: VendorAsset): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const file = vendorPath(name);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (cause) {
    throw new Error(
      `Could not read the vendored asset '${name}' from '${file}'. ` +
        'Reinstall dependencies (for example `npm install`) and try again.',
      { cause }
    );
  }

  cache.set(name, source);
  return source;
}
