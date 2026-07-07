import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Posting, SignalEvent } from '../src/types.js';
import { classifyPostings } from '../src/signals/hiring.js';
import { fixtureLlm, liveLlm, CLASSIFY_MODEL, type LlmClient } from '../src/llm.js';

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

function stubLlm(responses: Record<string, string>): { client: LlmClient; calls: { id: string; prompt: string }[] } {
  const calls: { id: string; prompt: string }[] = [];
  return {
    calls,
    client: {
      async classify(input) {
        calls.push(input);
        const response = responses[input.id];
        if (response === undefined) {
          throw new Error(`stubLlm: no canned response for ${input.id}`);
        }
        return response;
      },
    },
  };
}

describe('classifyPostings', () => {
  const postings: Posting[] = [
    {
      id: 'p1',
      title: 'Senior Growth Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/p1',
      publishedAt: '2026-06-01',
      location: 'Remote - US',
    },
    {
      id: 'p2',
      title: 'Founding GTM Lead',
      url: 'https://jobs.lever.co/acme/p2',
      publishedAt: '2026-05-15',
    },
    {
      id: 'p3',
      title: 'Recruiting Coordinator',
      url: 'https://jobs.ashbyhq.com/acme/p3',
      publishedAt: '', // ashby-style: provider omitted a date
    },
  ];

  it('maps canned labels to SignalEvents (subtype/date/url/summary/id), using asOf when publishedAt is empty', async () => {
    const { client } = stubLlm({
      'acme:p1': 'growth-eng',
      'acme:p2': 'first-gtm',
      'acme:p3': 'other',
    });

    const events = await classifyPostings('acme', postings, client, '2026-07-06', 'greenhouse');

    expect(events).toEqual<SignalEvent[]>([
      {
        id: 'hiring:acme:p1',
        accountId: 'acme',
        type: 'hiring',
        subtype: 'growth-eng',
        date: '2026-06-01',
        url: 'https://boards.greenhouse.io/acme/jobs/p1',
        summary: 'Senior Growth Engineer',
        confidence: 0.9,
        source: 'greenhouse',
        demo: false,
      },
      {
        id: 'hiring:acme:p2',
        accountId: 'acme',
        type: 'hiring',
        subtype: 'first-gtm',
        date: '2026-05-15',
        url: 'https://jobs.lever.co/acme/p2',
        summary: 'Founding GTM Lead',
        confidence: 0.9,
        source: 'greenhouse',
        demo: false,
      },
      // p3 -> 'other' produces no event at all.
    ]);
  });

  it('substitutes asOf for empty publishedAt when the label is not other', async () => {
    const { client } = stubLlm({ 'acme:p3': 'ai-eng' });

    const events = await classifyPostings('acme', [postings[2]], client, '2026-07-06', 'greenhouse');

    expect(events).toHaveLength(1);
    expect(events[0].date).toBe('2026-07-06');
  });

  it('sends one classify call per posting, sequentially, with the composite id and a prompt naming title+location', async () => {
    const { client, calls } = stubLlm({
      'acme:p1': 'growth-eng',
      'acme:p2': 'first-gtm',
      'acme:p3': 'other',
    });

    await classifyPostings('acme', postings, client, '2026-07-06', 'greenhouse');

    expect(calls.map((c) => c.id)).toEqual(['acme:p1', 'acme:p2', 'acme:p3']);
    expect(calls[0].prompt).toContain('Senior Growth Engineer');
    expect(calls[0].prompt).toContain('Remote - US');
    expect(calls[0].prompt).toMatch(/growth-eng/);
    expect(calls[0].prompt).toMatch(/generic-eng/);
  });

  it('sets demo:true only when source is "fixture"', async () => {
    const { client } = stubLlm({ 'acme:p1': 'growth-eng' });
    const events = await classifyPostings('acme', [postings[0]], client, '2026-07-06', 'fixture');
    expect(events[0].demo).toBe(true);
    expect(events[0].source).toBe('fixture');
  });

  it('treats a non-label response as "other", drops the event, and warns once with the raw response and posting id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = stubLlm({ 'acme:p1': 'I think this is growth engineering' });

    const events = await classifyPostings('acme', [postings[0]], client, '2026-07-06', 'greenhouse');

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0].join(' ');
    expect(message).toContain('I think this is growth engineering');
    expect(message).toContain('p1');

    warnSpy.mockRestore();
  });

  it('is case-insensitive and trims whitespace around valid labels', async () => {
    const { client } = stubLlm({ 'acme:p1': '  Growth-Eng  \n' });
    const events = await classifyPostings('acme', [postings[0]], client, '2026-07-06', 'greenhouse');
    expect(events).toHaveLength(1);
    expect(events[0].subtype).toBe('growth-eng');
  });

  it.each([
    ['double quotes', '"growth-eng"', 'growth-eng'],
    ['single quotes', "'first-gtm'", 'first-gtm'],
    ['backticks', '`ai-eng`', 'ai-eng'],
    ['a trailing period', 'generic-eng.', 'generic-eng'],
  ])('accepts a label wrapped in %s without warning', async (_desc, raw, expected) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = stubLlm({ 'acme:p1': raw });

    const events = await classifyPostings('acme', [postings[0]], client, '2026-07-06', 'greenhouse');

    expect(events).toHaveLength(1);
    expect(events[0].subtype).toBe(expected);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('never starts classify call N+1 before call N has resolved (strictly sequential)', async () => {
    let inFlight = 0;
    let overlapped = false;
    const labels: Record<string, string> = {
      'acme:p1': 'growth-eng',
      'acme:p2': 'first-gtm',
      'acme:p3': 'other',
    };
    const client: LlmClient = {
      classify(input) {
        if (inFlight > 0) overlapped = true;
        inFlight += 1;
        // Resolve on a later tick so a Promise.all-style implementation would
        // start all three calls before any resolves — and trip `overlapped`.
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(labels[input.id]);
          }, 0);
        });
      },
    };

    const events = await classifyPostings('acme', postings, client, '2026-07-06', 'greenhouse');

    expect(overlapped).toBe(false);
    expect(events).toHaveLength(2);
  });
});

describe('fixtureLlm', () => {
  const fixturePath = 'tests/fixtures/llm/hiring-sample.json';

  it('returns the mapped response for a known id', async () => {
    const client = fixtureLlm(fixturePath);
    const result = await client.classify({ id: 'acme:123', prompt: 'unused' });
    expect(result).toBe('growth-eng');
  });

  it('throws an error naming both the missing id and the fixture path for an unknown id', async () => {
    const client = fixtureLlm(fixturePath);
    await expect(client.classify({ id: 'acme:does-not-exist', prompt: 'unused' })).rejects.toThrow(
      /acme:does-not-exist/,
    );
    await expect(client.classify({ id: 'acme:does-not-exist', prompt: 'unused' })).rejects.toThrow(
      new RegExp(fixturePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('does not read the file at construction time — an invalid path only fails once classify is called', () => {
    expect(() => fixtureLlm('tests/fixtures/llm/does-not-exist.json')).not.toThrow();
  });
});

describe('liveLlm', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not throw when constructed without ANTHROPIC_API_KEY set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
    expect(() => liveLlm(CLASSIFY_MODEL)).not.toThrow();
  });

  it('rejects classify with a message naming ANTHROPIC_API_KEY when it is unset (no live call made)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
    const client = liveLlm(CLASSIFY_MODEL);
    await expect(client.classify({ id: 'acme:p1', prompt: 'irrelevant' })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
