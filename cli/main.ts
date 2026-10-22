import { Command } from 'commander';
import * as path from 'node:path';
import pc from 'picocolors';
import { importLegacy, renderDir } from './legacy';
import { runParser } from './pipeline';
import { chatInfoFromZip } from './zip';

function fail(err: unknown): void {
  console.error(pc.red('✗ ' + (err instanceof Error ? err.message : String(err))));
  process.exitCode = 1;
}

function printOutputs(base: string): void {
  console.log(
    pc.dim('  rendered:') +
      ` ${path.join(base, 'messages.json')}` +
      ` ${path.join(base, 'messages.md')}` +
      ` ${path.join(base, 'messages.html')}`,
  );
}

/** The commander program (no side effects until `parseAsync`). */
export function buildCli(): Command {
  // Positional options: `import-legacy f --out x` gives --out to the subcommand.
  const program = new Command().enablePositionalOptions();
  program
    .name('memory-archive')
    .description(
      'Read a WhatsApp "Export chat" ZIP and produce a normalized CSV backup.',
    )
    .argument('[zip]', 'path to a WhatsApp "Export chat" ZIP')
    .option('--zip <path>', 'path to the export ZIP (alternative to the positional argument)')
    .option('--out <dir>', 'output root; the chat goes to <out>/<chat-name>/ (default: output)')
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
Commands for existing outputs:
  memory-archive import-legacy <messages.json|messages.html|messages.csv> [--out <dir>]
  memory-archive render <dir>

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
        const base = path.join((opts.out as string | undefined) ?? 'output', slug);
        console.log(
          pc.green(`✓ Merged ${count} new message(s)`) +
            pc.dim(` into ${path.join(base, 'messages.csv')}`),
        );
        printOutputs(base);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('import-legacy')
    .description(
      'rebuild messages.csv from an old messages.json / messages.html / messages.csv and re-render all outputs ' +
        '(Markdown is lossy and not supported)',
    )
    .argument('<file>', 'messages.json, messages.html or messages.csv')
    .option('--out <dir>', 'output root; the chat goes to <out>/<chat-name>/ (default: the file\'s folder)')
    .option('--name <chat>', 'chat name (default: from the file, or the folder name)')
    .option('--me <name>', 'author name of the export owner (outgoing bubbles)')
    .option('--inline', 'embed resolved media as base64 into the HTML')
    .action(async (file: string, opts: Record<string, unknown>) => {
      try {
        const res = await importLegacy(file, {
          out: opts.out as string | undefined,
          name: opts.name as string | undefined,
          me: opts.me as string | undefined,
          inline: Boolean(opts.inline),
        });
        console.log(
          pc.green(`✓ Imported ${res.total} message(s), ${res.added} new`) +
            pc.dim(` into ${path.join(res.dir, 'messages.csv')}`),
        );
        printOutputs(res.dir);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('render')
    .description('re-render messages.json / .md / .html from <dir>/messages.csv (offline)')
    .argument('<dir>', 'folder that contains messages.csv')
    .option('--name <chat>', 'chat name (default: from messages.json, or the folder name)')
    .option('--me <name>', 'author name of the export owner (outgoing bubbles)')
    .option('--inline', 'embed resolved media as base64 into the HTML')
    .action(async (dir: string, opts: Record<string, unknown>) => {
      try {
        await renderDir(dir, {
          name: opts.name as string | undefined,
          me: opts.me as string | undefined,
          inline: Boolean(opts.inline),
        });
        console.log(pc.green('✓ Re-rendered') + pc.dim(` ${dir}`));
        printOutputs(dir);
      } catch (err) {
        fail(err);
      }
    });

  return program;
}
