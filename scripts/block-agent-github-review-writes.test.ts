import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitHubReviewWrite } from '../scripts/block-agent-github-review-writes.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'block-agent-github-review-writes.mjs',
);

const BLOCKED = [
  'gh pr comment 345 --body "AI review"',
  'gh pr review 345 --approve --body "LGTM"',
  'gh issue comment 345 --body-file /tmp/review.md',
  'gh api repos/org/repo/pulls/345/comments -f body="finding"',
  'gh api repos/org/repo/pulls/345/reviews --method POST --input review.json',
  'gh api -X PATCH repos/org/repo/issues/comments/1 -f body="edit"',
  "gh api graphql -f query='mutation { addPullRequestReview(input: {}) { clientMutationId } }'",
  'curl -X POST https://api.github.com/repos/org/repo/pulls/345/comments -d @review.json',
  'curl --data @review.json https://api.github.com/repos/org/repo/pulls/345/reviews',
  'gh -R org/repo pr comment 345 --body x',
  'gh --repo org/repo pr review 345 --approve',
  'gh api repos/org/repo/issues/345/comments --field body=x',
  'gh api repos/org/repo/issues/345/comments --raw-field body=x',
  'gh api repos/org/repo/issues/345/comments -F body=@review.md',
  'gh -R org/repo api repos/org/repo/pulls/345/reviews --method POST',
  'curl --json @review.json https://api.github.com/repos/org/repo/issues/345/comments',
  "node -e \"fetch('https://api.github.com/repos/o/r/issues/1/comments',{method:'POST',body:'x'})\"",
  'bash -c "gh pr comment 1 --body x"',
];

const ALLOWED = [
  'gh pr view 345 --json files,reviews,comments',
  'gh pr diff 345',
  'gh api repos/org/repo/pulls/345/comments --paginate',
  "gh api graphql -f query='query { repository(owner: \"org\", name: \"repo\") { name } }'",
  'gh pr create --base dev --title "feat: example" --body "approved preview"',
  'curl https://api.github.com/repos/org/repo/pulls/345/comments',
  'gh api repos/org/repo/pulls/345/comments --method GET -f per_page=100',
  'gh -R org/repo pr view 345',
];

/** Runs the hook the way Claude Code does: JSON payload on stdin. */
function runHook(stdin: string) {
  return spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });
}

describe('agent GitHub review write guard', () => {
  for (const command of BLOCKED) {
    test(`blocks ${command}`, () => {
      assert.equal(isGitHubReviewWrite(command), true);
    });
  }

  for (const command of ALLOWED) {
    test(`allows read-only or PR-creation command ${command}`, () => {
      assert.equal(isGitHubReviewWrite(command), false);
    });
  }

  test('hook process exits 2 with a reason for a review write', () => {
    const result = runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr comment 1 --body x' } }),
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /may not publish GitHub comments or reviews/);
  });

  test('hook process exits 0 for a read', () => {
    const result = runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr view 1' } }),
    );
    assert.equal(result.status, 0);
  });

  test('hook process fails closed (exit 2) on a malformed payload', () => {
    assert.equal(runHook('not json').status, 2);
    assert.equal(runHook('{"tool_input":').status, 2);
  });

  test('hook process allows an empty payload (OpenCode pipes none)', () => {
    assert.equal(runHook('').status, 0);
  });
});
