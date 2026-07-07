import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Account, AuditRow, AtsProvider } from '../src/types.js';
import { auditAccounts } from '../src/audit.js';
import { resolveRss } from '../src/sources/rss.js';
import { renderAuditTable } from '../src/output/table.js';
import { demoProbeBoard, demoProbeRss } from '../src/cli.js';
import type { ProbeResult } from '../src/sources/ats.js';

// Guard against accidental live network anywhere in this suite: if any code
// path falls back to the global fetch instead of an injected fake, fail loudly.
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected live fetch');
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('auditAccounts', () => {
  const accounts: Account[] = [
    {
      id: 'acme',
      name: 'Acme',
      domain: 'acme.com',
      group: 'core',
      ats: { provider: 'greenhouse', slug: 'acme' },
      rss: 'https://acme.com/feed',
    },
    { id: 'no-slug', name: 'NoSlug', domain: 'noslug.com', group: 'core' },
    { id: 'beta', name: 'Beta', domain: 'beta.com', group: 'contrast', ats: { provider: 'lever', slug: 'beta' } },
  ];

  it('produces rows with correct ats/rss values, only probing ATS for accounts with a slug, in list order', async () => {
    const boardCalls: Array<[string, string]> = [];
    const rssCalls: string[] = [];

    const fakeProbeBoard = vi.fn(async (provider: AtsProvider, slug: string): Promise<ProbeResult> => {
      boardCalls.push([provider, slug]);
      if (provider === 'greenhouse' && slug === 'acme') return { reachable: true, postingCount: 5 };
      return { reachable: false };
    });

    const fakeProbeRss = vi.fn(async (domain: string, rss?: string) => {
      rssCalls.push(domain);
      return rss ? { resolvable: true, feedUrl: rss } : { resolvable: false };
    });

    const rows = await auditAccounts(accounts, {
      probeBoard: fakeProbeBoard,
      probeRss: fakeProbeRss,
      delayMs: 0,
    });

    expect(rows).toHaveLength(3);

    expect(rows[0]).toMatchObject({
      accountId: 'acme',
      group: 'core',
      atsReachable: true,
      atsProvider: 'greenhouse',
      postingCount: 5,
      rssResolvable: true,
    });

    expect(rows[1]).toMatchObject({
      accountId: 'no-slug',
      group: 'core',
      atsReachable: null,
      rssResolvable: false,
    });
    expect(rows[1].atsProvider).toBeUndefined();
    expect(rows[1].notes.length).toBeGreaterThan(0);

    expect(rows[2]).toMatchObject({
      accountId: 'beta',
      group: 'contrast',
      atsReachable: false,
      atsProvider: 'lever',
      rssResolvable: false,
    });

    // probeBoard only called for accounts with an ats entry configured, in list order
    expect(boardCalls).toEqual([
      ['greenhouse', 'acme'],
      ['lever', 'beta'],
    ]);
    // probeRss called for every account, in list order
    expect(rssCalls).toEqual(['acme.com', 'noslug.com', 'beta.com']);
  });

  it('passes demo through onto each row and runs with zero delay when delayMs is 0', async () => {
    const demoAccounts: Account[] = [
      { id: 'd1', name: 'D1', domain: 'd1.example', group: 'core', demo: true },
      { id: 'd2', name: 'D2', domain: 'd2.example', group: 'core' },
    ];
    const start = Date.now();
    const rows = await auditAccounts(demoAccounts, {
      probeBoard: async () => ({ reachable: true, postingCount: 0 }),
      probeRss: async () => ({ resolvable: true }),
      delayMs: 0,
    });
    expect(Date.now() - start).toBeLessThan(200);
    expect(rows[0].demo).toBe(true);
    expect(rows[1].demo).toBeUndefined();
  });
});

describe('resolveRss', () => {
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

  it('tries only the explicit rss URL when provided and it resolves', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([{ status: 200, body: '<rss version="2.0"></rss>' }]);
    const result = await resolveRss('acme.com', 'https://acme.com/custom-feed.xml', fetchImpl);
    expect(result).toEqual({ resolvable: true, feedUrl: 'https://acme.com/custom-feed.xml' });
    expect(calls).toEqual(['https://acme.com/custom-feed.xml']);
  });

  it('falls back to the guessed paths in order when the explicit rss URL misses', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([
      { status: 404 }, // explicit rss URL misses
      { status: 404 }, // /feed
      { status: 200, body: '<rss version="2.0"></rss>' }, // /rss.xml resolves
    ]);
    const result = await resolveRss('acme.com', 'https://acme.com/dead-feed.xml', fetchImpl);
    expect(calls).toEqual([
      'https://acme.com/dead-feed.xml',
      'https://acme.com/feed',
      'https://acme.com/rss.xml',
    ]);
    expect(result).toEqual({ resolvable: true, feedUrl: 'https://acme.com/rss.xml' });
  });

  it('does not try the explicit rss URL twice when it equals a guessed path', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([
      { status: 404 }, // https://acme.com/feed (explicit, same as first guess)
      { status: 404 }, // /rss.xml
      { status: 404 }, // /blog/rss.xml
      { status: 404 }, // /atom.xml
    ]);
    const result = await resolveRss('acme.com', 'https://acme.com/feed', fetchImpl);
    expect(calls).toEqual([
      'https://acme.com/feed',
      'https://acme.com/rss.xml',
      'https://acme.com/blog/rss.xml',
      'https://acme.com/atom.xml',
    ]);
    expect(result).toEqual({ resolvable: false });
  });

  it('tries fallback paths in order when no rss is given, stopping at the first hit', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([
      { status: 404 },
      { status: 200, body: '<html><body>not a feed</body></html>' }, // 200 but no <rss/<feed marker
      { status: 200, body: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' },
    ]);
    const result = await resolveRss('acme.com', undefined, fetchImpl);
    expect(calls).toEqual([
      'https://acme.com/feed',
      'https://acme.com/rss.xml',
      'https://acme.com/blog/rss.xml',
    ]);
    expect(result).toEqual({ resolvable: true, feedUrl: 'https://acme.com/blog/rss.xml' });
  });

  it('returns resolvable:false when every fallback path misses (mixing rejects, wrong status, and bodies without markers)', async () => {
    const { fetchImpl, calls } = fakeFetchSequence([
      { status: 404 },
      'reject',
      { status: 200, body: 'plain text, no feed markers here' },
      { status: 500 },
    ]);
    const result = await resolveRss('acme.com', undefined, fetchImpl);
    expect(result).toEqual({ resolvable: false });
    expect(calls).toEqual([
      'https://acme.com/feed',
      'https://acme.com/rss.xml',
      'https://acme.com/blog/rss.xml',
      'https://acme.com/atom.xml',
    ]);
  });

  it('matches <rss/<feed case-insensitively', async () => {
    const { fetchImpl } = fakeFetchSequence([{ status: 200, body: '<RSS version="2.0"></RSS>' }]);
    const result = await resolveRss('acme.com', 'https://acme.com/upper-feed.xml', fetchImpl);
    expect(result.resolvable).toBe(true);
  });
});

describe('renderAuditTable', () => {
  function row(partial: Partial<AuditRow> & Pick<AuditRow, 'accountId' | 'group'>): AuditRow {
    return {
      atsReachable: null,
      rssResolvable: false,
      notes: [],
      ...partial,
    };
  }

  it('computes per-group ATS/RSS percentages, counting null atsReachable in the denominator', () => {
    const rows: AuditRow[] = [
      row({ accountId: 'a1', group: 'core', atsReachable: true, rssResolvable: true }),
      row({ accountId: 'a2', group: 'core', atsReachable: true, rssResolvable: false }),
      row({ accountId: 'a3', group: 'core', atsReachable: null, rssResolvable: true }), // no slug configured
      row({ accountId: 'b1', group: 'contrast', atsReachable: false, rssResolvable: false }),
      row({ accountId: 'b2', group: 'contrast', atsReachable: null, rssResolvable: false }),
    ];

    const output = renderAuditTable(rows);
    const lines = output.split('\n');

    expect(lines[0]).toBe('core     ATS 2/3 (67%) · RSS 2/3 (67%)');
    expect(lines[1]).toBe('contrast ATS 0/2 (0%) · RSS 0/2 (0%)');
  });

  it('omits the demo footer when no row is demo', () => {
    const rows: AuditRow[] = [row({ accountId: 'a1', group: 'core' })];
    expect(renderAuditTable(rows)).not.toContain('synthetic demo data');
  });

  it('appends the demo footer when any row is demo', () => {
    const rows: AuditRow[] = [
      row({ accountId: 'a1', group: 'core' }),
      row({ accountId: 'a2', group: 'core', demo: true }),
    ];
    expect(renderAuditTable(rows)).toContain('⚠ synthetic demo data — fictional companies');
  });

  it('includes a per-account row with id, ats provider+count, rss marker, and notes', () => {
    const rows: AuditRow[] = [
      row({
        accountId: 'acme',
        group: 'core',
        atsReachable: true,
        atsProvider: 'greenhouse',
        postingCount: 4,
        rssResolvable: true,
      }),
      row({
        accountId: 'no-slug',
        group: 'core',
        atsReachable: null,
        rssResolvable: false,
        notes: ['no ats slug configured'],
      }),
    ];
    const output = renderAuditTable(rows);
    expect(output).toContain('acme');
    expect(output).toContain('greenhouse');
    expect(output).toContain('4');
    expect(output).toContain('✓');
    expect(output).toContain('no-slug');
    expect(output).toContain('no ats slug configured');
  });
});

describe('demo mode mock probes (cli)', () => {
  const throwingFetch = (async () => {
    throw new Error('Unexpected fetch call in demo mode');
  }) as unknown as typeof fetch;

  it('demoProbeBoard reports reachable without touching fetch', async () => {
    const result = await demoProbeBoard('greenhouse', 'whatever', throwingFetch);
    expect(result.reachable).toBe(true);
  });

  it('demoProbeRss reports resolvable iff rss is set, without touching fetch', async () => {
    const withRss = await demoProbeRss('acme.example', 'https://acme.example/feed', throwingFetch);
    expect(withRss.resolvable).toBe(true);

    const withoutRss = await demoProbeRss('beta.example', undefined, throwingFetch);
    expect(withoutRss.resolvable).toBe(false);
  });

  it('running a full audit through the demo deps makes zero fetch calls, even for accounts with no ats entry', async () => {
    const demoAccounts: Account[] = [
      {
        id: 'has-ats',
        name: 'HasAts',
        domain: 'has-ats.example',
        group: 'core',
        demo: true,
        ats: { provider: 'ashby', slug: 'has-ats' },
        rss: 'https://has-ats.example/feed',
      },
      { id: 'no-ats', name: 'NoAts', domain: 'no-ats.example', group: 'contrast', demo: true },
    ];

    const rows = await auditAccounts(demoAccounts, {
      probeBoard: demoProbeBoard,
      probeRss: demoProbeRss,
      fetchImpl: throwingFetch,
      delayMs: 0,
    });

    expect(rows[0]).toMatchObject({ accountId: 'has-ats', atsReachable: true, rssResolvable: true, demo: true });
    expect(rows[1]).toMatchObject({ accountId: 'no-ats', atsReachable: null, rssResolvable: false, demo: true });
  });
});
