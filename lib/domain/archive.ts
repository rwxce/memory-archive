/**
 * Version of the archive file format (`memory-archive-YYYY-MM-DD.zip`):
 * manifest layout, file paths and their meaning. Bumped only when an older
 * reader could misread a newer file; readers accept every version they ever
 * shipped and refuse newer ones.
 */
export const ARCHIVE_FORMAT_VERSION = 1;

/** `format` field of the archive manifest. */
export const ARCHIVE_FORMAT_NAME = 'memory-archive';
