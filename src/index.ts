#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import pc from 'picocolors';
import { runParser } from './model';
import { chatInfoFromZip } from './extract';

export function buildCli() {
  const program = new Command();
  program
    .name('wa-backup')
    .description(
      'Read a WhatsApp "Export chat" ZIP and produce a normalized CSV backup.',
    )
    .argument('[zip]', 'path to a WhatsApp "Export chat" ZIP')
    .option('--zip <path>', 'path to the export ZIP (alternative to the positional argument)')
    .option('--out <dir>', 'output directory (default: <chat-name>/ under cwd)')
    .option('--day-first', 'force day/month date order')
    .option('--month-first', 'force month/day date order')
    .option('--verbose', 'report detected format, locale guess, overrides')
  .option('--inline', 'embed resolved media as base64 into a single self-contained HTML file')
  .option('--no-fetch-titles', 'skip fetching webpage titles (offline)')
    .addHelpText(
      'after',
      `
Examples:
  npx tsx src/index.ts "WhatsApp Chat - X.zip" --out ./backup --verbose
  wa-backup --zip "WhatsApp Chat - X.zip" --out ./backup
  npm run dev -- "WhatsApp Chat - X.zip" --verbose

Note the "--" in the npm form: without it, npm swallows flags like --verbose.`,
    )
    .action(async (zipPos: string | undefined, opts: Record<string, unknown>) => {
      const zip = zipPos ?? (opts.zip as string | undefined);
      if (!zip) {
        console.error(pc.red('✗ No ZIP path given. Pass it positionally or via --zip <path>.'));
        program.help({ error: true });
        return;
      }
      if (zipPos && opts.zip) {
        console.error(pc.red('✗ Give the ZIP either positionally or via --zip, not both.'));
        process.exitCode = 1;
        return;
      }
      try {
        const count = await runParser(zip, {
          out: opts.out as string | undefined,
          dayFirst: Boolean(opts.dayFirst),
          monthFirst: Boolean(opts.monthFirst),
          verbose: Boolean(opts.verbose),
          inline: Boolean(opts.inline),
          noFetchTitles: Boolean((opts as Record<string, unknown>).noFetchTitles ?? (opts as Record<string, unknown>).fetchTitles === false),
        });
        const { slug } = await chatInfoFromZip(zip);
        const outDir = (opts.out as string | undefined) ?? 'output';
        const base = path.join(outDir, slug);
        // eslint-disable-next-line no-console
        console.log(
          pc.green(`✓ Merged ${count} new message(s)`) +
            pc.dim(` into ${path.join(base, 'messages.csv')}`),
        );
        // eslint-disable-next-line no-console
        console.log(
          pc.dim('  rendered:') +
            ` ${path.join(base, 'messages.json')}` +
            ` ${path.join(base, 'messages.md')}` +
            ` ${path.join(base, 'messages.html')}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(pc.red('✗ ' + (err instanceof Error ? err.message : String(err))));
        process.exitCode = 1;
      }
    });
  return program;
}

buildCli().parseAsync(process.argv);
