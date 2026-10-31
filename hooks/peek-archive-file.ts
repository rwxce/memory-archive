import { ArchiveError } from '@/lib/usecases/archive-backup';
import { detectArchiveFile } from '@/lib/usecases/changes-pack-import';

/**
 * What a file the person picked is, without opening it: `backup` (a full backup), `changes-pack` (a sync pack), `encrypted` (a
 * password-protected file, which only says what it is once opened) or `unknown`. Looks inside the file (its manifest), never at
 * its name. A file that cannot be read counts as `unknown`: the screen that goes on reports the real problem.
 */
export type PeekedFile = 'backup' | 'changes-pack' | 'encrypted' | 'unknown';

export async function peekArchiveFile(file: Blob): Promise<PeekedFile> {
  try {
    return (await detectArchiveFile(file)).kind;
  } catch (error) {
    return error instanceof ArchiveError && error.code === 'password-required' ? 'encrypted' : 'unknown';
  }
}
