import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import { OUTPUT, buildViewerScript, renderGeneratedModule } from './build-viewer-script.mjs';

describe('viewer script bundle', () => {
  test('committed viewer-script.generated.ts is up to date with the .js sources', () => {
    expect(fs.readFileSync(OUTPUT, 'utf8')).toBe(renderGeneratedModule());
  });

  test('bundle is one classic script: no import/export, parses, defines populateTranscript', () => {
    const script = buildViewerScript();
    expect(script).not.toMatch(/^\s*(import|export)\b/m);
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('function populateTranscript');
    expect(script).toContain('function linkifyHtml');
    expect(script).toContain('function setText');
  });
});
