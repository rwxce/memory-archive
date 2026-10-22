// Cleans the message of a `release: vX.Y.Z` commit on main: keeps the PR title and body, drops
// what GitHub appends when a release PR is squash-merged from the web UI.
//
//   git log -1 --format=%B <sha> | node scripts/clean-release-message.mjs
//
// Why: main's history was rewritten (docs/branching-and-releases.md), so dev's older commits are
// not reachable from main and every release PR lists all of them. GitHub's merge button then adds
// a `Co-authored-by:` trailer for every author it finds there. release.yml recreates the commit
// with the cleaned message (same tree, parent and author) before tagging it.
//
// Prints the cleaned message; exits 0 whether or not anything changed.

import { fileURLToPath } from 'node:url';

const SEPARATOR = /^-{9}$/;
const CO_AUTHOR = /^co-authored-by:/i;

/** The message without GitHub's `---------` block and without any `Co-authored-by:` trailer. */
export function cleanReleaseMessage(message) {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((line) => SEPARATOR.test(line.trim()));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !CO_AUTHOR.test(line.trim()));
  // Same normalisation as `git stripspace`: no trailing spaces, no runs of blank lines, no blank edges.
  const out = [];
  for (const line of kept.map((l) => l.replace(/\s+$/, ''))) {
    if (line === '' && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(line);
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(cleanReleaseMessage(input));
}
