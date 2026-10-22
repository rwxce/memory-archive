import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ESLint } from 'eslint';

// Architecture as code: proves the layer, cycle, i18n and console rules in
// eslint.config.js fire (and do not fire) where intended. Each case lints a
// snippet as if it lived at `filePath`; imports resolve against real files.

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((m) => m.severity === 2 && m.ruleId !== 'local/require-test-file') // snippets have no sibling test
    .map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

describe('eslint architecture rules', () => {
  test.each([
    ['lib/domain/x.ts', "import { cn } from '@/components/ui/utils';\nexport const a = cn;"],
    ['lib/domain/x.ts', "import { createLogger } from '@/lib/log';\nimport { parseWhatsAppZip } from '@/lib/importers/whatsapp';\nexport const a = [createLogger, parseWhatsAppZip];"],
    ['lib/importers/x.ts', "import { THEME_CHOICES } from '@/hooks/theme';\nexport const a = THEME_CHOICES;"],
    ['hooks/x.ts', "import { cn } from '@/components/ui/utils';\nexport const a = cn;"],
    ['components/x.tsx', "import { parseWhatsAppZip } from '@/lib/importers/whatsapp';\nexport const a = parseWhatsAppZip;"],
    ['app/x.tsx', "import { renderHtml } from '@/lib/exporters/legacy';\nexport const a = renderHtml;"],
  ])('boundaries: %s may not import upward or skip use cases (%#)', async (file, code) => {
    expect(await ruleIds(file, code)).toContain('boundaries/dependencies');
  });

  test.each([
    ['app/x.tsx', "import { Button } from '@/components/ui/button';\nimport { ARCHIVE_FORMAT_VERSION } from '@/lib/domain/archive';\nexport const a = [Button, ARCHIVE_FORMAT_VERSION];"],
    ['components/x.tsx', "import { useTheme } from '@/hooks/use-theme';\nimport { routing } from '@/i18n/routing';\nexport const a = [useTheme, routing];"],
    ['lib/importers/x.ts', "import { createLogger } from '@/lib/log';\nimport { renderJson } from '@/lib/exporters/legacy';\nexport const a = [createLogger, renderJson];"],
    ['cli/x.ts', "import { parseWhatsAppZip } from '@/lib/importers/whatsapp';\nexport const a = parseWhatsAppZip;"],
  ])('boundaries: %s may import downward (%#)', async (file, code) => {
    expect(await ruleIds(file, code)).toEqual([]);
  });

  test('lib/ never imports React or Next.js', async () => {
    expect(await ruleIds('lib/domain/x.ts', "import { useState } from 'react';\nexport const a = useState;")).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds('lib/db/x.ts', "import Link from 'next/link';\nexport const a = Link;")).toContain(
      'no-restricted-imports',
    );
  });

  test('i18next/no-literal-string: JSX text in app/ and components/ must come from messages', async () => {
    const code = 'export function X() {\n  return <p>Hello there</p>;\n}\n';
    expect(await ruleIds('components/x.tsx', code)).toContain('i18next/no-literal-string');
    expect(await ruleIds('app/x.tsx', code)).toContain('i18next/no-literal-string');
    expect(await ruleIds('components/x.tsx', 'export function X({ t }: { t: string }) {\n  return <p className="a">{t}</p>;\n}\n')).toEqual([]);
  });

  test('no-console outside lib/log.ts (CLI and scripts excepted)', async () => {
    expect(await ruleIds('components/x.tsx', "console.log('x');\n")).toContain('no-console');
    expect(await ruleIds('lib/domain/x.ts', "console.warn('x');\n")).toContain('no-console');
    expect(await ruleIds('lib/log.ts', "console.warn('x');\n")).not.toContain('no-console');
    expect(await ruleIds('cli/x.ts', "console.log('x');\n")).not.toContain('no-console');
  });

  test('import-x/no-cycle: two modules importing each other', async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'hooks', 'eslint-cycle-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), "import { b } from './b';\nexport const a = () => b;\n");
      fs.writeFileSync(path.join(dir, 'b.ts'), "import { a } from './a';\nexport const b = () => a;\n");
      const [result] = await eslint.lintFiles([path.join(dir, 'a.ts')]);
      expect(result.messages.map((m) => m.ruleId)).toContain('import-x/no-cycle');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
