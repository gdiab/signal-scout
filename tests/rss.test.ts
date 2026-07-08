import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveRss, discoverFeedFromHtml, fetchFeedItems } from '../src/sources/rss.js';

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/rss/${name}`, 'utf-8');
}

describe('discoverFeedFromHtml', () => {
  it('finds the feed link in a sample homepage and resolves a relative href against baseUrl', () => {
    const html = fixture('homepage-with-link.html');
    const result = discoverFeedFromHtml(html, 'https://fernwoodanalytics.example/');
    expect(result).toBe('https://fernwoodanalytics.example/blog/atom.xml');
  });

  it('matches rel/type case-insensitively regardless of attribute order', () => {
    const html = '<html><head><link type="application/rss+xml" REL="ALTERNATE" HREF="https://x.example/feed.xml"></head></html>';
    expect(discoverFeedFromHtml(html, 'https://x.example/')).toBe('https://x.example/feed.xml');
  });

  it('accepts a token-list rel value containing alternate', () => {
    const html = '<html><head><link rel="alternate nofollow" type="application/rss+xml" href="https://x.example/feed.xml"></head></html>';
    expect(discoverFeedFromHtml(html, 'https://x.example/')).toBe('https://x.example/feed.xml');
  });

  it('entity-decodes the href (&amp; in a query string becomes a literal &)', () => {
    const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed?format=rss&amp;lang=en"></head></html>';
    expect(discoverFeedFromHtml(html, 'https://x.example/')).toBe('https://x.example/feed?format=rss&lang=en');
  });

  it('returns undefined when there is no matching link tag', () => {
    const html = '<html><head><link rel="stylesheet" href="/styles.css"></head><body>hi</body></html>';
    expect(discoverFeedFromHtml(html, 'https://fernwoodanalytics.example/')).toBeUndefined();
  });

  it('ignores link tags with an unrelated type value', () => {
    const html = '<html><head><link rel="alternate" type="text/html" href="/other-page"></head></html>';
    expect(discoverFeedFromHtml(html, 'https://fernwoodanalytics.example/')).toBeUndefined();
  });
});

describe('fetchFeedItems', () => {
  it('normalizes an RSS sample: titles, urls, ISO dates, newest-first, CDATA decoded, no-link item skipped, unparseable date omitted', async () => {
    const body = fixture('rss-sample.xml');
    const fetchImpl = (async () => ({ status: 200, text: async () => body }) as unknown as Response) as unknown as typeof fetch;

    const items = await fetchFeedItems('https://nimbusrobotics.example/rss.xml', fetchImpl);

    expect(items).toEqual([
      {
        title: 'Nimbus Robotics closes $12M Series A',
        url: 'https://nimbusrobotics.example/news/series-a',
        date: '2025-02-03',
      },
      {
        title: 'Nimbus & Partners launch new warehouse line',
        url: 'https://nimbusrobotics.example/news/warehouse-line',
        date: '2025-01-14',
      },
      {
        title: 'Nimbus hits 50 engineers',
        url: 'https://nimbusrobotics.example/news/fifty-engineers',
      },
    ]);
  });

  it('normalizes an Atom sample: titles, urls, ISO dates (updated|published), newest-first, entities decoded', async () => {
    const body = fixture('atom-sample.xml');
    const fetchImpl = (async () => ({ status: 200, text: async () => body }) as unknown as Response) as unknown as typeof fetch;

    const items = await fetchFeedItems('https://lighthousemetrics.example/atom.xml', fetchImpl);

    expect(items).toEqual([
      {
        title: 'Product update: faster ingest <beta>',
        url: 'https://lighthousemetrics.example/log/faster-ingest',
        date: '2025-04-05',
      },
      {
        title: 'Lighthouse Metrics & the "signal" problem',
        url: 'https://lighthousemetrics.example/log/signal-problem',
        date: '2025-03-10',
      },
      {
        title: "We're hiring a founding engineer",
        url: 'https://lighthousemetrics.example/log/founding-engineer',
        date: '2025-02-01',
      },
    ]);
  });

  it('entity-decodes an Atom link href containing &amp; into a literal &', async () => {
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      '  <entry>',
      '    <title>Query-string permalink</title>',
      '    <link href="https://lighthousemetrics.example/log?id=7&amp;ref=feed" rel="alternate"/>',
      '    <updated>2025-05-01T08:00:00Z</updated>',
      '  </entry>',
      '</feed>',
    ].join('\n');
    const fetchImpl = (async () => ({ status: 200, text: async () => body }) as unknown as Response) as unknown as typeof fetch;

    const items = await fetchFeedItems('https://lighthousemetrics.example/atom.xml', fetchImpl);

    expect(items).toEqual([
      {
        title: 'Query-string permalink',
        url: 'https://lighthousemetrics.example/log?id=7&ref=feed',
        date: '2025-05-01',
      },
    ]);
  });

  it('returns [] when the feed responds non-200', async () => {
    const fetchImpl = (async () => ({ status: 404, text: async () => '' }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchFeedItems('https://x.example/feed.xml', fetchImpl)).toEqual([]);
  });

  it('returns [] when the body is not XML/feed content', async () => {
    const fetchImpl = (async () =>
      ({ status: 200, text: async () => '<html><body>not a feed</body></html>' }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchFeedItems('https://x.example/feed.xml', fetchImpl)).toEqual([]);
  });

  it('returns [] when the fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network fail');
    }) as unknown as typeof fetch;
    expect(await fetchFeedItems('https://x.example/feed.xml', fetchImpl)).toEqual([]);
  });
});

describe('resolveRss homepage discovery fallback', () => {
  type FakeResponse = { status: number; body?: string } | 'reject';

  function fakeFetchSequence(responses: FakeResponse[]): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      const resp = responses[i++];
      if (resp === 'reject' || resp === undefined) throw new Error('network fail');
      return {
        status: resp.status,
        text: async () => resp.body ?? '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('falls back to homepage <link rel=alternate> discovery when all path candidates 404, verifying the discovered URL before returning it', async () => {
    const homepageHtml = fixture('homepage-with-link.html');
    const { fetchImpl, calls } = fakeFetchSequence([
      { status: 404 }, // /feed
      { status: 404 }, // /rss.xml
      { status: 404 }, // /blog/rss.xml
      { status: 404 }, // /atom.xml
      { status: 200, body: homepageHtml }, // homepage fetch
      { status: 200, body: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' }, // verify discovered feed
    ]);

    const result = await resolveRss('fernwoodanalytics.example', undefined, fetchImpl);

    expect(calls).toEqual([
      'https://fernwoodanalytics.example/feed',
      'https://fernwoodanalytics.example/rss.xml',
      'https://fernwoodanalytics.example/blog/rss.xml',
      'https://fernwoodanalytics.example/atom.xml',
      'https://fernwoodanalytics.example/',
      'https://fernwoodanalytics.example/blog/atom.xml',
    ]);
    expect(result).toEqual({ resolvable: true, feedUrl: 'https://fernwoodanalytics.example/blog/atom.xml' });
  });

  it('is not resolvable when the homepage has no discoverable feed link', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([
      { status: 404 },
      { status: 404 },
      { status: 404 },
      { status: 404 },
      { status: 200, body: '<html><head><title>No feed here</title></head></html>' },
    ]);

    const result = await resolveRss('no-feed.example', undefined, fetchImpl);

    expect(calls).toEqual([
      'https://no-feed.example/feed',
      'https://no-feed.example/rss.xml',
      'https://no-feed.example/blog/rss.xml',
      'https://no-feed.example/atom.xml',
      'https://no-feed.example/',
    ]);
    expect(result).toEqual({ resolvable: false });
  });

  it('is not resolvable when the homepage fetch itself errors', async () => {
    const { fetchImpl } = fakeFetchSequence([{ status: 404 }, { status: 404 }, { status: 404 }, { status: 404 }, 'reject']);
    const result = await resolveRss('down.example', undefined, fetchImpl);
    expect(result).toEqual({ resolvable: false });
  });

  it('does not attempt homepage discovery once a path candidate already resolves', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([{ status: 200, body: '<rss version="2.0"></rss>' }]);
    const result = await resolveRss('quick-hit.example', undefined, fetchImpl);
    expect(calls).toEqual(['https://quick-hit.example/feed']);
    expect(result).toEqual({ resolvable: true, feedUrl: 'https://quick-hit.example/feed' });
  });
});
