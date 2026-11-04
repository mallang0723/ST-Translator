import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fingerprints from '../src/presets/upstream/prompt-fingerprints.json';
import * as catalog from '../src/presets/catalog';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('presets copied from Marinara-Translation-Tools 1.5.4', () => {
  test('prompt text and metadata match the upstream SHA-256 fingerprints', () => {
    for (const [name, expected] of Object.entries(fingerprints)) {
      expect(sha((catalog as Record<string, unknown>)[name])).toBe(expected);
    }
  });
});
