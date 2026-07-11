import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey } from '../src/keys.js';

describe('resolveApiKey', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keys-test-'));
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the env var with source "env" when set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    expect(resolveApiKey(dir)).toEqual({ key: 'sk-from-env', source: 'env' });
  });

  it('prefers the env var over a .env file (precedence)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-from-file\n');
    expect(resolveApiKey(dir)).toEqual({ key: 'sk-from-env', source: 'env' });
  });

  it('reads ANTHROPIC_API_KEY from ./.env when the env var is unset', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-from-file\n');
    expect(resolveApiKey(dir)).toEqual({ key: 'sk-from-file', source: '.env' });
  });

  it('returns null when neither env var nor .env exists', () => {
    expect(resolveApiKey(dir)).toBeNull();
  });

  it('returns null when .env exists but has no ANTHROPIC_API_KEY line', () => {
    writeFileSync(join(dir, '.env'), 'OTHER_VAR=abc\n# just a comment\n');
    expect(resolveApiKey(dir)).toBeNull();
  });

  it('treats an empty value as missing', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=\n');
    expect(resolveApiKey(dir)).toBeNull();
  });

  it('ignores comment lines, tolerates whitespace, strips matching quotes', () => {
    writeFileSync(
      join(dir, '.env'),
      '# comment mentioning ANTHROPIC_API_KEY=nope\n  ANTHROPIC_API_KEY = "sk-quoted"  \n',
    );
    expect(resolveApiKey(dir)).toEqual({ key: 'sk-quoted', source: '.env' });
  });

  it('does not read any other variable from .env', () => {
    writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=leak\nANTHROPIC_API_KEY=sk-ok\n');
    expect(resolveApiKey(dir)).toEqual({ key: 'sk-ok', source: '.env' });
    expect(process.env.SECRET_TOKEN).toBeUndefined();
  });
});
