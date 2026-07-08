import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Account, SignalEvent } from '../src/types.js';
import { matchArticles, type CandidateArticle } from '../src/signals/press.js';
import type { LlmClient } from '../src/llm.js';

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

function stubLlm(responses: Record<string, string>): {
  client: LlmClient;
  calls: { id: string; prompt: string; maxTokens?: number }[];
} {
  const calls: { id: string; prompt: string; maxTokens?: number }[] = [];
  return {
    calls,
    client: {
      async classify() {
        throw new Error('stubLlm: classify() is not used by matchArticles');
      },
      async generate(input) {
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

const accounts: Account[] = [
  { id: 'acme', name: 'Acme AI', domain: 'acme.example', group: 'core' },
  { id: 'globex', name: 'Globex Robotics', domain: 'globex.example', group: 'core' },
];

describe('matchArticles', () => {
  it('turns a confident funding match into a funding event: subtype round, amount folded into summary, extracted date wins over item date', async () => {
    const item: CandidateArticle = {
      title: 'Acme AI raises new round',
      url: 'https://news.example/articles/acme-raises-18m',
      date: '2026-07-01',
      summary: 'Acme AI announced funding.',
    };
    const { client } = stubLlm({
      'press-match:sweep:acme-raises-18m': JSON.stringify({
        accountId: 'acme',
        confidence: 0.95,
        category: 'funding',
        amount: '$18M',
        date: '2026-06-28',
      }),
    });

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(reviewQueue).toEqual([]);
    expect(events).toEqual<SignalEvent[]>([
      {
        id: 'funding:acme:acme-raises-18m',
        accountId: 'acme',
        type: 'funding',
        subtype: 'round',
        date: '2026-06-28',
        url: 'https://news.example/articles/acme-raises-18m',
        summary: 'Acme AI raises new round — $18M',
        confidence: 0.95,
        source: 'rss',
        demo: false,
      },
    ]);
  });

  it('turns a confident product-category match into a press event', async () => {
    const item: CandidateArticle = {
      title: 'Acme AI ships a new feature',
      url: 'https://news.example/articles/acme-ships-feature',
      date: '2026-07-02',
    };
    const { client } = stubLlm({
      'press-match:sweep:acme-ships-feature': JSON.stringify({
        accountId: 'acme',
        confidence: 0.8,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    const { events } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual<SignalEvent[]>([
      {
        id: 'press:acme:acme-ships-feature',
        accountId: 'acme',
        type: 'press',
        subtype: 'article',
        date: '2026-07-02',
        url: 'https://news.example/articles/acme-ships-feature',
        summary: 'Acme AI ships a new feature',
        confidence: 0.8,
        source: 'rss',
        demo: false,
      },
    ]);
  });

  it('accountId: null produces no event and no review item', async () => {
    const item: CandidateArticle = {
      title: 'Unrelated industry roundup',
      url: 'https://news.example/articles/roundup',
    };
    const { client } = stubLlm({
      'press-match:sweep:roundup': JSON.stringify({
        accountId: null,
        confidence: 0.9,
        category: 'other',
        amount: null,
        date: null,
      }),
    });

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(reviewQueue).toEqual([]);
  });

  it('confidence below 0.6 goes to the review queue with a reason, and produces no event', async () => {
    const item: CandidateArticle = {
      title: 'Maybe about Acme?',
      url: 'https://news.example/articles/maybe-acme',
    };
    const { client } = stubLlm({
      'press-match:sweep:maybe-acme': JSON.stringify({
        accountId: 'acme',
        confidence: 0.4,
        category: 'other',
        amount: null,
        date: null,
      }),
    });

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(reviewQueue).toEqual([
      {
        url: 'https://news.example/articles/maybe-acme',
        title: 'Maybe about Acme?',
        accountId: 'acme',
        confidence: 0.4,
        reason: 'low-confidence match (0.4 < 0.6)',
      },
    ]);
  });

  it('own-feed candidate forces the owner account id regardless of the model response, and boosts confidence to at least 0.9', async () => {
    const item: CandidateArticle = {
      title: 'From our newsroom: a product update',
      url: 'https://acme.example/blog/update',
      ownAccountId: 'acme',
    };
    const { client, calls } = stubLlm({
      'press-match:acme:update': JSON.stringify({
        accountId: null,
        confidence: 0.5,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    const { events } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(calls[0].id).toBe('press-match:acme:update');
    expect(events).toHaveLength(1);
    expect(events[0].accountId).toBe('acme');
    expect(events[0].confidence).toBe(0.9);
  });

  it('dedupes by (accountId, url): the first confident match wins, the second candidate for the same pair produces no extra event', async () => {
    const ownItem: CandidateArticle = {
      title: 'Acme AI raises new round',
      url: 'https://news.example/articles/acme-raises-18m',
      date: '2026-07-01',
      ownAccountId: 'acme',
    };
    const sweepItem: CandidateArticle = {
      title: 'Acme AI raises new round',
      url: 'https://news.example/articles/acme-raises-18m',
      date: '2026-07-01',
    };
    const { client } = stubLlm({
      'press-match:acme:acme-raises-18m': JSON.stringify({
        accountId: null,
        confidence: 0.95,
        category: 'funding',
        amount: '$18M',
        date: '2026-06-28',
      }),
      'press-match:sweep:acme-raises-18m': JSON.stringify({
        accountId: 'acme',
        confidence: 0.95,
        category: 'funding',
        amount: '$18M',
        date: '2026-06-28',
      }),
    });

    const { events } = await matchArticles([ownItem, sweepItem], accounts, client, '2026-07-06', 'rss');

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('funding:acme:acme-raises-18m');
  });

  it('undated item with no extracted date produces an event with dateEstimated:true and date = asOf', async () => {
    const item: CandidateArticle = {
      title: 'Acme AI ships a new feature',
      url: 'https://news.example/articles/undated-feature',
    };
    const { client } = stubLlm({
      'press-match:sweep:undated-feature': JSON.stringify({
        accountId: 'acme',
        confidence: 0.8,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    const { events } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toHaveLength(1);
    expect(events[0].date).toBe('2026-07-06');
    expect(events[0].dateEstimated).toBe(true);
  });

  it('a funding article with no extracted date and no item date also gets dateEstimated:true, date = asOf', async () => {
    const item: CandidateArticle = {
      title: 'Acme AI raises new round',
      url: 'https://news.example/articles/undated-funding',
    };
    const { client } = stubLlm({
      'press-match:sweep:undated-funding': JSON.stringify({
        accountId: 'acme',
        confidence: 0.95,
        category: 'funding',
        amount: '$18M',
        date: null,
      }),
    });

    const { events } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toHaveLength(1);
    expect(events[0].date).toBe('2026-07-06');
    expect(events[0].dateEstimated).toBe(true);
  });

  it('malformed JSON is skipped with a warning; other candidates are still processed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badItem: CandidateArticle = {
      title: 'Garbage response article',
      url: 'https://news.example/articles/garbage',
    };
    const goodItem: CandidateArticle = {
      title: 'Acme AI ships a new feature',
      url: 'https://news.example/articles/good',
      date: '2026-07-02',
    };
    const { client } = stubLlm({
      'press-match:sweep:garbage': 'not json at all',
      'press-match:sweep:good': JSON.stringify({
        accountId: 'acme',
        confidence: 0.8,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    const { events } = await matchArticles([badItem, goodItem], accounts, client, '2026-07-06', 'rss');

    expect(events).toHaveLength(1);
    expect(events[0].url).toBe('https://news.example/articles/good');
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(message).toContain('garbage');

    warnSpy.mockRestore();
  });

  it('an unknown accountId (not in the accounts list) is skipped with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item: CandidateArticle = {
      title: 'Some other company news',
      url: 'https://news.example/articles/other-co',
    };
    const { client } = stubLlm({
      'press-match:sweep:other-co': JSON.stringify({
        accountId: 'not-a-real-account',
        confidence: 0.9,
        category: 'funding',
        amount: '$1M',
        date: '2026-07-01',
      }),
    });

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(reviewQueue).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('an unrecognized category is treated like a parse failure: warn + skip', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item: CandidateArticle = {
      title: 'Weird category article',
      url: 'https://news.example/articles/weird-category',
    };
    const { client } = stubLlm({
      'press-match:sweep:weird-category': JSON.stringify({
        accountId: 'acme',
        confidence: 0.9,
        category: 'acquisition',
        amount: null,
        date: null,
      }),
    });

    const { events } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('a numeric accountId is malformed, not a null match: warn + skip, other candidates still processed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badItem: CandidateArticle = {
      title: 'Numeric accountId article',
      url: 'https://news.example/articles/numeric-id',
    };
    const goodItem: CandidateArticle = {
      title: 'Acme AI ships a new feature',
      url: 'https://news.example/articles/still-good',
      date: '2026-07-02',
    };
    const { client } = stubLlm({
      'press-match:sweep:numeric-id': JSON.stringify({
        accountId: 42,
        confidence: 0.9,
        category: 'product',
        amount: null,
        date: null,
      }),
      'press-match:sweep:still-good': JSON.stringify({
        accountId: 'acme',
        confidence: 0.8,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    const { events, reviewQueue } = await matchArticles(
      [badItem, goodItem],
      accounts,
      client,
      '2026-07-06',
      'rss',
    );

    expect(events).toHaveLength(1);
    expect(events[0].url).toBe('https://news.example/articles/still-good');
    expect(reviewQueue).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(message).toContain('numeric-id');

    warnSpy.mockRestore();
  });

  it('a confidence outside 0..1 is malformed: warn + skip, no event, no review item', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item: CandidateArticle = {
      title: 'Overconfident article',
      url: 'https://news.example/articles/overconfident',
    };
    const { client } = stubLlm({
      'press-match:sweep:overconfident': JSON.stringify({
        accountId: 'acme',
        confidence: 1.7,
        category: 'funding',
        amount: '$5M',
        date: '2026-07-01',
      }),
    });

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(reviewQueue).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it.each([
    ['non-string amount', { accountId: 'acme', confidence: 0.9, category: 'funding', amount: 18, date: null }],
    ['non-string date', { accountId: 'acme', confidence: 0.9, category: 'funding', amount: '$18M', date: 20260701 }],
    ['negative confidence', { accountId: 'acme', confidence: -0.2, category: 'other', amount: null, date: null }],
    ['missing accountId', { confidence: 0.9, category: 'product', amount: null, date: null }],
  ])('a response with %s is malformed: warn + skip', async (_desc, response) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item: CandidateArticle = {
      title: 'Malformed field article',
      url: 'https://news.example/articles/malformed-field',
    };
    const { client } = stubLlm({
      'press-match:sweep:malformed-field': JSON.stringify(response),
    });

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(reviewQueue).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('an own-feed candidate whose ownAccountId is not in the accounts list is skipped with a warning (no event, no LLM call)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item: CandidateArticle = {
      title: 'Post from an untracked account feed',
      url: 'https://stranger.example/blog/post',
      ownAccountId: 'stranger',
    };
    const { client, calls } = stubLlm({});

    const { events, reviewQueue } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toEqual([]);
    expect(reviewQueue).toEqual([]);
    expect(calls).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(message).toContain('stranger');

    warnSpy.mockRestore();
  });

  it('strips a single ```json fence before parsing', async () => {
    const item: CandidateArticle = {
      title: 'Acme AI ships a new feature',
      url: 'https://news.example/articles/fenced',
      date: '2026-07-02',
    };
    const fenced = '```json\n' + JSON.stringify({
      accountId: 'acme',
      confidence: 0.8,
      category: 'product',
      amount: null,
      date: null,
    }) + '\n```';
    const { client } = stubLlm({ 'press-match:sweep:fenced': fenced });

    const { events } = await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(events).toHaveLength(1);
  });

  it('sends generate() calls sequentially with maxTokens 300, and sweep prompt lists id | name | domain for all accounts', async () => {
    const item: CandidateArticle = {
      title: 'Acme AI ships a new feature',
      url: 'https://news.example/articles/prompt-check',
    };
    const { client, calls } = stubLlm({
      'press-match:sweep:prompt-check': JSON.stringify({
        accountId: 'acme',
        confidence: 0.8,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(calls).toHaveLength(1);
    expect(calls[0].maxTokens).toBe(300);
    expect(calls[0].prompt).toContain('acme | Acme AI | acme.example');
    expect(calls[0].prompt).toContain('globex | Globex Robotics | globex.example');
    expect(calls[0].prompt).toContain('Acme AI ships a new feature');
  });

  it('own-feed prompt names the account and does not list the full account roster', async () => {
    const item: CandidateArticle = {
      title: 'From our newsroom',
      url: 'https://acme.example/blog/post',
      ownAccountId: 'acme',
    };
    const { client, calls } = stubLlm({
      'press-match:acme:post': JSON.stringify({
        accountId: 'acme',
        confidence: 0.7,
        category: 'product',
        amount: null,
        date: null,
      }),
    });

    await matchArticles([item], accounts, client, '2026-07-06', 'rss');

    expect(calls[0].prompt).toContain('Acme AI');
    expect(calls[0].prompt).not.toContain('Globex Robotics');
  });
});
