#!/usr/bin/env node
/**
 * PreToolUse hook (Bash, fail-closed: unparseable payload => block): agents may read pull requests but may
 * never publish GitHub comments or reviews — a human verifies and posts any
 * review in their own words. Wired from `.rulesync/hooks.jsonc`.
 *
 * Reads the hook payload (JSON) from stdin. Exit 0 = allow, exit 2 = block
 * (the stderr message is fed back to the agent).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// `gh` plus any global flags that may precede the subcommand (`gh -R o/r pr comment`).
const GH = String.raw`\bgh(?:\s+(?:-R|--repo|--hostname)(?:\s+|=)\S+)*`;

const GH_REVIEW_WRITE_PATTERNS = [
  new RegExp(String.raw`${GH}\s+pr\s+(?:comment|review)\b`, 'i'),
  new RegExp(String.raw`${GH}\s+issue\s+comment\b`, 'i'),
];

const GH_API = new RegExp(String.raw`${GH}\s+api\b`, 'i');
const GH_API_METHOD_WRITE = /(?:--method|-X)(?:\s+|=)['"]?(?:POST|PUT|PATCH|DELETE)\b/i;
const GH_API_METHOD_GET = /(?:--method|-X)(?:\s+|=)['"]?GET\b/i;
// Any field flag switches `gh api` from GET to POST, even without --method.
const GH_API_FIELD = /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s|=|\S)/;
const GH_API_INPUT = /(?:^|\s)--input\b/;

// Raw HTTP clients (curl, wget, node -e fetch, python requests, ...) talking to the GitHub API.
const GITHUB_API_HOST = /api\.github\.com/i;
const GITHUB_WRITE_TARGET = /\/(?:comments|reviews|issues|pulls)\b/i;
const HTTP_WRITE_SIGNAL =
  /(?:--data(?:-\w+)?|--json|--request|--upload-file|--post-(?:data|file)|--method|--body-data)\b|(?:^|\s)-(?:d|X|T)\b|\bfetch\s*\(|\bmethod\b|\.(?:post|put|patch|delete)\s*\(|\bPOST\b|\bPATCH\b/i;

/**
 * @param {string} command
 * @returns {boolean}
 */
function isGhApiWrite(command) {
  if (!GH_API.test(command)) return false;
  if (/\bgraphql\b/i.test(command)) return /\bmutation\b/i.test(command) || GH_API_INPUT.test(command);
  if (GH_API_METHOD_WRITE.test(command) || GH_API_INPUT.test(command)) return true;
  return GH_API_FIELD.test(command) && !GH_API_METHOD_GET.test(command);
}

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function isGitHubReviewWrite(command) {
  if (typeof command !== 'string') return false;
  if (GH_REVIEW_WRITE_PATTERNS.some((pattern) => pattern.test(command))) return true;
  if (isGhApiWrite(command)) return true;
  return (
    GITHUB_API_HOST.test(command) &&
    GITHUB_WRITE_TARGET.test(command) &&
    HTTP_WRITE_SIGNAL.test(command)
  );
}

function commandFromHookInput(input) {
  return input?.tool_input?.command ?? input?.toolInput?.command ?? input?.command ?? '';
}

function runHook() {
  const raw = fs.readFileSync(0, 'utf8');
  // No payload at all: OpenCode's generated plugin does not pipe one. Those sessions rely on the
  // `deny` rules in opencode.jsonc instead; nothing to inspect here.
  if (raw.trim() === '') process.exit(0);

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Fail closed: a payload we cannot parse is a payload we cannot vouch for.
    process.stderr.write('Blocked by repository policy: the hook payload is not valid JSON.\n');
    process.exit(2);
  }

  if (!isGitHubReviewWrite(commandFromHookInput(input))) process.exit(0);

  process.stderr.write(
    'Blocked by repository policy: agents may read pull requests but may not publish GitHub comments or reviews. Return the review privately for a human to verify and rewrite.\n',
  );
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook();
