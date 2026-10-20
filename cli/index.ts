#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import pc from 'picocolors';
import { runParser } from './pipeline';
import { chatInfoFromZip } from './zip';

export function buildCli() {
  const program = new Command();
  program
    .name('memory-archive')
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
    .option('--me <name>', 'author name of the export owner (outgoing bubbles); default: most active author')
    .option('--fetch-titles', 'fetch webpage titles for links (network; off by default)')
    .option('--no-fetch-titles', 'do not fetch webpage titles (default; kept for compatibility)')
    .addHelpText(
      'after',
      `
Examples:
  memory-archive "WhatsApp Chat - X.zip" --out ./backup --verbose
  memory-archive --zip "WhatsApp Chat - X.zip" --out ./backup
  pnpm dev "WhatsApp Chat - X.zip" --verbose`,
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
          fetchTitles: opts.fetchTitles === true,
          me: typeof opts.me === 'string' ? opts.me : undefined,
        });
        const { slug } = await chatInfoFromZip(zip);
        const outDir = (opts.out as string | undefined) ?? 'output';
        const base = path.join(outDir, slug);
        console.log(
          pc.green(`✓ Merged ${count} new message(s)`) +
            pc.dim(` into ${path.join(base, 'messages.csv')}`),
        );
        console.log(
          pc.dim('  rendered:') +
            ` ${path.join(base, 'messages.json')}` +
            ` ${path.join(base, 'messages.md')}` +
            ` ${path.join(base, 'messages.html')}`,
        );
      } catch (err) {
        console.error(pc.red('✗ ' + (err instanceof Error ? err.message : String(err))));
        process.exitCode = 1;
      }
    });
  return program;
}

buildCli().parseAsync(process.argv);
