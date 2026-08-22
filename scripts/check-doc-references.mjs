#!/usr/bin/env node
/**
 * Fails when the codebase cites an architecture document that does not exist.
 *
 * Source comments in this repository carry the decision record a piece of code
 * implements, as a repository-root path. That citation is the only link between
 * the two — nothing resolves it, so when a document is renamed or renumbered the
 * pointer rots silently and the next reader follows it into nothing. TAR-444
 * found one that had been dead for eight days; TAR-772 is this check, so the
 * next one dies in the pull request that introduces it.
 *
 * What it checks: every `docs/architecture/<name>.md` written as a path from the
 * repository root, in any tracked text file, resolves to a file that exists.
 *
 * What it does NOT check, deliberately:
 *
 *   - Relative links between documents (`./0002-....md` between two files in
 *     `docs/architecture`, `../architecture/....md` from `docs/reference`).
 *     Resolving those needs the citing file's directory rather than the
 *     repository root, and they are the form least likely to rot because they
 *     sit next to what they point at.
 *   - Documents outside `docs/architecture`, and anchors within a document.
 *
 * Widening any of those is a change to REFERENCE_PATTERN and the resolution
 * below, not a rewrite.
 *
 * Run it with `pnpm docs:check-refs`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Deliberately narrow: a path from the repository root to a Markdown file in
// `docs/architecture`. Written with escaped separators so this file does not
// match its own pattern and report itself.
const REFERENCE_PATTERN = /docs\/architecture\/[A-Za-z0-9._-]+\.md/g;

// Every tracked file today is text, so this exists to keep the check honest the
// first time somebody commits a screenshot rather than to filter anything now.
const BINARY_EXTENSIONS = new Set([
  'gif',
  'ico',
  'jpeg',
  'jpg',
  'pdf',
  'png',
  'webp',
  'woff',
  'woff2',
  'zip',
]);

function listTrackedFiles() {
  // `git ls-files` rather than a directory walk: it is already the list of files
  // that can carry a citation, and it excludes `node_modules`, build output and
  // anything else `.gitignore` covers without this script having to know about them.
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  return output
    .split('\0')
    .filter((path) => path.length > 0)
    .filter((path) => !BINARY_EXTENSIONS.has(path.split('.').pop().toLowerCase()));
}

const broken = [];
const seen = new Set();
let citations = 0;

for (const file of listTrackedFiles()) {
  const contents = readFileSync(join(REPO_ROOT, file), 'utf8');

  // Cheap reject first: most of the 1,800 tracked files cite nothing.
  if (!contents.includes('docs/architecture/')) continue;

  contents.split(/\r?\n/).forEach((line, index) => {
    for (const [reference] of line.matchAll(REFERENCE_PATTERN)) {
      citations += 1;
      seen.add(reference);

      if (!existsSync(join(REPO_ROOT, reference))) {
        broken.push({ file, line: index + 1, reference });
      }
    }
  });
}

if (broken.length > 0) {
  console.error(
    `${broken.length} reference(s) to an architecture document that does not exist:\n` +
      broken.map(({ file, line, reference }) => `  - ${file}:${line} → ${reference}`).join('\n') +
      '\n\nEither the document was renamed or renumbered and the citation was not\n' +
      'updated with it, or the citation was written from memory. Fix the path — and\n' +
      'if the document really is gone, say what replaced it rather than deleting the\n' +
      'pointer, because the code still implements whatever it decided.',
  );

  process.exit(1);
}

console.log(
  `Checked ${citations} citation(s) of ${seen.size} architecture document(s): every one resolves.`,
);
