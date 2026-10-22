import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPnpm } from './only-pnpm.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'only-pnpm.mjs');

function run(userAgent: string | undefined) {
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  if (userAgent !== undefined) env.npm_config_user_agent = userAgent;
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
}

describe('only-pnpm preinstall guard', () => {
  test('accepts pnpm user agents', () => {
    assert.equal(isPnpm('pnpm/11.0.0 npm/? node/v24.0.0 darwin arm64'), true);
    assert.equal(run('pnpm/11.0.0 npm/? node/v24.0.0 darwin arm64').status, 0);
  });

  test('rejects npm, yarn and a missing user agent', () => {
    for (const ua of ['npm/10.0.0 node/v24.0.0', 'yarn/4.0.0 npm/? node/v24.0.0', undefined]) {
      assert.equal(isPnpm(ua), false);
      const result = run(ua);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /uses pnpm/);
    }
  });
});
