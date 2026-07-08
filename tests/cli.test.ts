import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainModule, selectRecentPostings, writeReviewQueue } from '../src/cli.js';
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
