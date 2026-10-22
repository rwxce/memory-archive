#!/usr/bin/env node
/**
 * `preinstall` guard: only pnpm may install this repo's dependencies. Replaces
 * `npx only-allow pnpm`, which downloaded an unpinned package before the
 * 7-day release age could apply. Pure Node, no dependencies.
 */
import { pathToFileURL } from 'node:url';

/**
 * @param {string | undefined} userAgent value of `npm_config_user_agent`
 * @returns {boolean}
 */
export function isPnpm(userAgent) {
  return typeof userAgent === 'string' && /^pnpm\//.test(userAgent);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!isPnpm(process.env.npm_config_user_agent)) {
    process.stderr.write('This repository uses pnpm. Run `pnpm install` (see package.json "packageManager").\n');
    process.exit(1);
  }
}
