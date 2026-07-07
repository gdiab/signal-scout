import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { probeBoard, fetchPostings } from '../src/sources/ats.js';

// Guard against accidental live network: if any code path falls back to the
// global fetch instead of the injected fake, the test fails loudly.
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

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`tests/fixtures/ats/${name}`, 'utf-8'));
}

function fakeFetchOk(body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

function fakeFetchStatus(status: number): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    }) as unknown as Response) as unknown as typeof fetch;
}

function fakeFetch404(): typeof fetch {
  return fakeFetchStatus(404);
}

function fakeFetchRejects(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe('fetchPostings - greenhouse', () => {
  const fixture = loadFixture('greenhouse-sample.json');

  it('normalizes greenhouse jobs into Postings', async () => {
    const postings = await fetchPostings('greenhouse', 'acme', fakeFetchOk(fixture));
    expect(postings).toHaveLength(2);
    expect(postings[0]).toEqual({
      id: '4123456',
      title: 'Senior Growth Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/4123456',
      publishedAt: '2026-06-01',
      location: 'Remote - US',
    });
    expect(postings[1].publishedAt).toBe('2026-05-15');
  });

  it('throws naming provider+slug+status on non-200', async () => {
    await expect(fetchPostings('greenhouse', 'acme', fakeFetch404())).rejects.toThrow(
      /greenhouse.*acme.*404/i,
    );
  });

  it('throws on a non-200 success-family status (204) too', async () => {
    await expect(fetchPostings('greenhouse', 'acme', fakeFetchStatus(204))).rejects.toThrow(
      /greenhouse.*acme.*204/i,
    );
  });
});

describe('fetchPostings - lever', () => {
  const fixture = loadFixture('lever-sample.json');

  it('normalizes lever postings into Postings', async () => {
    const postings = await fetchPostings('lever', 'acme', fakeFetchOk(fixture));
    expect(postings).toHaveLength(2);
    // Fixture createdAt is 1751848200000 = 2025-07-07T00:30:00.000Z (non-midnight,
    // hard-coded so the assertion does not mirror the production date math).
    expect(postings[0]).toEqual({
      id: 'a1b2c3d4-0000-1111-2222-333344445555',
      title: 'AI Applied Engineer',
      url: 'https://jobs.lever.co/acme/a1b2c3d4-0000-1111-2222-333344445555',
      publishedAt: '2025-07-07',
      location: 'San Francisco, CA',
    });
    expect(postings[1].publishedAt).toBe('2025-05-18');
  });

  it('throws naming provider+slug+status on non-200', async () => {
    await expect(fetchPostings('lever', 'acme', fakeFetch404())).rejects.toThrow(
      /lever.*acme.*404/i,
    );
  });
});

describe('fetchPostings - ashby', () => {
  const fixture = loadFixture('ashby-sample.json');

  it('normalizes ashby jobs into Postings with empty publishedAt', async () => {
    const postings = await fetchPostings('ashby', 'acme', fakeFetchOk(fixture));
    expect(postings).toHaveLength(2);
    expect(postings[0]).toEqual({
      id: 'e5f6a7b8-4444-5555-6666-777788889999',
      title: 'Staff Software Engineer, Growth',
      url: 'https://jobs.ashbyhq.com/acme/e5f6a7b8-4444-5555-6666-777788889999',
      publishedAt: '',
      location: 'New York, NY',
    });
  });

  it('throws naming provider+slug+status on non-200', async () => {
    await expect(fetchPostings('ashby', 'acme', fakeFetch404())).rejects.toThrow(
      /ashby.*acme.*404/i,
    );
  });

  it('lets network-level rejection propagate', async () => {
    await expect(
      fetchPostings('ashby', 'acme', fakeFetchRejects('getaddrinfo ENOTFOUND')),
    ).rejects.toThrow(/ENOTFOUND/);
  });
});

describe('probeBoard', () => {
  it('reports reachable:true with postingCount from fetchPostings for greenhouse', async () => {
    const fixture = loadFixture('greenhouse-sample.json');
    const result = await probeBoard('greenhouse', 'acme', fakeFetchOk(fixture));
    expect(result).toEqual({ reachable: true, postingCount: 2 });
  });

  it('reports reachable:true postingCount:0 when a board has zero postings', async () => {
    const result = await probeBoard('ashby', 'acme', fakeFetchOk({ jobs: [] }));
    expect(result).toEqual({ reachable: true, postingCount: 0 });
  });

  it('reports reachable:false (no error) on 404', async () => {
    const result = await probeBoard('lever', 'acme', fakeFetch404());
    expect(result).toEqual({ reachable: false });
  });

  it('reports reachable:false with error message on network rejection', async () => {
    const result = await probeBoard('ashby', 'acme', fakeFetchRejects('getaddrinfo ENOTFOUND'));
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });
});
