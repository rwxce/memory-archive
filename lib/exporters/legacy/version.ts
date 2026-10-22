/**
 * Identity written into every JSON envelope (`messages.json` and the
 * `chat-data` island of `messages.html`). Kept as constants so `lib/` does not
 * import `package.json`; a test keeps the version in sync with it.
 */
export const GENERATOR_NAME = 'memory-archive';
export const GENERATOR_VERSION = '0.4.1';

/**
 * Version of the legacy JSON envelope (docs/formats/legacy-json.md).
 * 0 = wa-backup outputs without the field; 1 = adds `schemaVersion` and
 * `generator`. Bump on any change a reader must know about.
 */
export const LEGACY_JSON_SCHEMA_VERSION = 1;
