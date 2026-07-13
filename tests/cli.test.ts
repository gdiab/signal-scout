import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMainModule,
  selectRecentPostings,
  writeReviewQueue,
  parseNonNegativeNumber,
  ensureApiKey,
  runLiftLive,
} from '../src/cli.js';
import type { Posting, ReviewItem } from '../src/types.js';

describe('isMainModule', () => {
  it('matches when the entry-point path contains a space (regression: import.meta.url percent-encodes spaces, argv[1] does not)', () => {
    const argv1 = '/private/tmp/space dir/src/cli.ts';
    const metaUrl = pathToFileURL(argv1).href;
    expect(metaUrl).not.toBe(`file://${argv1}`); // sanity check: the naive comparison really would have missed
    expect(isMainModule(metaUrl, argv1)).toBe(true);
  });

  it('matches for a plain path with no special characters', () => {
    const argv1 = '/Users/gd/github/signal-scout/src/cli.ts';
    const metaUrl = pathToFileURL(argv1).href;
    expect(isMainModule(metaUrl, argv1)).toBe(true);
  });

  it('returns false when argv1 is undefined (e.g. some non-standard invocations)', () => {
    expect(isMainModule('file:///foo/bar.js', undefined)).toBe(false);
  });

  it('returns false when the paths genuinely differ', () => {
    expect(isMainModule('file:///foo/bar.js', '/foo/baz.js')).toBe(false);
  });
});

describe('selectRecentPostings', () => {
  function posting(id: string, publishedAt: string): Posting {
    return { id, title: `title-${id}`, url: `https://x.example/${id}`, publishedAt };
  }

  it('keeps only the n most recent postings by publishedAt, descending', () => {
    const postings = [posting('1', '2026-01-01'), posting('2', '2026-03-01'), posting('3', '2026-02-01')];
    const result = selectRecentPostings(postings, 2);
    expect(result.map((p) => p.id)).toEqual(['2', '3']);
  });

  it('sorts postings with empty publishedAt last, regardless of input order', () => {
    const postings = [posting('1', ''), posting('2', '2026-01-01'), posting('3', '')];
    const result = selectRecentPostings(postings, 2);
    expect(result.map((p) => p.id)).toEqual(['2', '1']);
  });

  it('returns all postings, most-recent-first, when n exceeds the count', () => {
    const postings = [posting('1', '2026-01-01'), posting('2', '2026-02-01')];
    const result = selectRecentPostings(postings, 10);
    expect(result.map((p) => p.id)).toEqual(['2', '1']);
  });

  it('does not mutate the input array', () => {
    const postings = [posting('1', '2026-01-01'), posting('2', '2026-02-01')];
    const copy = [...postings];
    selectRecentPostings(postings, 1);
    expect(postings).toEqual(copy);
  });
});

describe('parseNonNegativeNumber', () => {
  it('parses a valid non-negative integer string', () => {
    expect(parseNonNegativeNumber('--max-postings', '40')).toBe(40);
  });

  it('accepts zero', () => {
    expect(parseNonNegativeNumber('--max-articles', '0')).toBe(0);
  });

  it('throws naming the flag and the raw value for a non-numeric string', () => {
    expect(() => parseNonNegativeNumber('--max-postings', 'abc')).toThrow(
      /--max-postings must be a non-negative number, got "abc"/,
    );
  });

  it('throws for a negative number', () => {
    expect(() => parseNonNegativeNumber('--max-articles', '-5')).toThrow(
      /--max-articles must be a non-negative number, got "-5"/,
    );
  });
});

describe('writeReviewQueue', () => {
  const item: ReviewItem = {
    url: 'https://news.example/articles/maybe',
    title: 'Maybe a match',
    accountId: 'acme',
    confidence: 0.45,
    reason: 'low-confidence match (0.45 < 0.6)',
  };

  it('writes one JSON line per item, overwriting any previous content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-queue-'));
    const path = join(dir, 'review-queue.jsonl');
    writeFileSync(path, 'stale content from a previous run\n');

    writeReviewQueue(path, [item, { ...item, accountId: 'globex' }]);

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(item);
    expect(JSON.parse(lines[1]).accountId).toBe('globex');
  });

  it('removes a stale file from a previous run when this run\'s queue is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-queue-'));
    const path = join(dir, 'review-queue.jsonl');
    writeFileSync(path, JSON.stringify(item) + '\n'); // previous run's queue

    writeReviewQueue(path, []);

    expect(existsSync(path)).toBe(false);
  });

  it('is a no-op when the queue is empty and no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-queue-'));
    const path = join(dir, 'review-queue.jsonl');

    expect(() => writeReviewQueue(path, [])).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe('runLiftLive --accounts', () => {
  const events = 'tests/fixtures/lift-accounts-events.jsonl';
  const signals = 'tests/fixtures/lift-accounts-signals.jsonl';
  const playbook = 'tests/fixtures/lift-accounts-playbook.json';

  it('scores against the given --accounts path, not a hardcoded default', () => {
    const output = runLiftLive({ events, signals, playbook, accounts: 'tests/fixtures/lift-accounts.json' });
    // a, b, c have the w1 signal ("with"); d, e, f don't ("without").
    // a, b replied (2/3 with); d replied (1/3 without) -> >=1.5x lift -> supported.
    expect(output).toMatch(/w1\s+status=untested\s+with 2\/3 \(67%\)\s+without 1\/3 \(33%\)\s+suggestion=supported/);
  });

  it('regression: a mismatched (default) accounts list scores nobody in the signal snapshot, all n=0', () => {
    // This is the exact bug from the finding: pointing --playbook at a
    // signals snapshot for one account universe while accounts silently
    // stays hardcoded to another produces meaningless all-zero rows.
    const output = runLiftLive({
      events,
      signals,
      playbook,
      accounts: 'accounts/ai-startups.json', // real accounts, none named a-f
    });
    expect(output).toMatch(/w1\s+status=untested\s+with 0\/0 \(n\/a\)\s+without 0\/0 \(n\/a\)\s+suggestion=inconclusive/);
  });
});

describe('ensureApiKey', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-key-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the key from .env into process.env and announces the source on stderr', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-from-file\n');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ensureApiKey();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-from-file');
    expect(errSpy).toHaveBeenCalledWith('using ANTHROPIC_API_KEY from .env');
    errSpy.mockRestore();
  });

  it('stays silent when the key comes from the environment', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ensureApiKey();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('throws the rich message (what was checked + fixes) when nothing resolves', () => {
    expect(() => ensureApiKey()).toThrow(/Checked:[\s\S]*\.env: not found[\s\S]*console\.anthropic\.com/);
  });
});
