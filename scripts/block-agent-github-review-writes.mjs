#!/usr/bin/env node
/**
 * PreToolUse hook (Bash, fail-closed): agents may read pull requests but may
 * never publish GitHub comments or reviews — a human verifies and posts any
 * review in their own words. Wired from `.rulesync/hooks.jsonc`.
 *
 * Reads the hook payload (JSON) from stdin. Exit 0 = allow, exit 2 = block
 * (the stderr message is fed back to the agent).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const GH_REVIEW_WRITE_PATTERNS = [
  /\bgh\s+pr\s+(?:comment|review)\b/i,
  /\bgh\s+issue\s+comment\b/i,
  /\bgh\s+api\b[\s\S]*?(?:--method|-X)\s*[='"]?(?:POST|PUT|PATCH|DELETE)\b/i,
  /\bgh\s+api\b[\s\S]*?(?:-f|-F)\s*[='"]?(?:body|event)\s*=/i,
  /\bgh\s+api\b[\s\S]*?--input\b/i,
  /\bgh\s+api\s+graphql\b[\s\S]*?\bmutation\b/i,
  /\b(?:curl|wget)\b[\s\S]*?api\.github\.com[\s\S]*?\/(?:comments|reviews)\b[\s\S]*?(?:--data|-d|--request|-X)\b/i,
  /\b(?:curl|wget)\b[\s\S]*?(?:--data|-d|--request|-X)\b[\s\S]*?api\.github\.com[\s\S]*?\/(?:comments|reviews)\b/i,
];

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function isGitHubReviewWrite(command) {
  return (
    typeof command === 'string' &&
    GH_REVIEW_WRITE_PATTERNS.some((pattern) => pattern.test(command))
  );
}

function commandFromHookInput(input) {
  return input?.tool_input?.command ?? input?.toolInput?.command ?? input?.command ?? '';
}

function runHook() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    // A malformed hook payload must not turn into a blanket shell outage.
    process.exit(0);
  }

  if (!isGitHubReviewWrite(commandFromHookInput(input))) process.exit(0);

  process.stderr.write(
    'Blocked by repository policy: agents may read pull requests but may not publish GitHub comments or reviews. Return the review privately for a human to verify and rewrite.\n',
  );
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook();
