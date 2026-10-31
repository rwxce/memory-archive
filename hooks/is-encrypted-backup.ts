import { isEncryptedBackup } from '@/lib/usecases/archive-backup';

/**
 * Whether the file the person picked is a password-protected backup (it starts with the format's magic
 * bytes; the name is never trusted). A file that cannot be read counts as not encrypted: the restore or
 * check that follows reports the real problem.
 */
export async function detectEncryptedBackup(file: Blob): Promise<boolean> {
  try {
    return await isEncryptedBackup(file);
  } catch {
    return false;
  }
}
