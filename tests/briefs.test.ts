import { describe, it, expect, vi } from 'vitest';
import type { Account, Brief, ScoredAccount, SignalEvent } from '../src/types.js';
import { writeBriefs } from '../src/briefs.js';
import { renderBriefs } from '../src/output/table.js';
import type { LlmClient } from '../src/llm.js';

function stubLlm(responses: Record<string, string>): {
  client: LlmClient;
  calls: { id: string; prompt: string; maxTokens?: number }[];
} {
  const calls: { id: string; prompt: string; maxTokens?: number }[] = [];
  return {
    calls,
    client: {
      async classify() {
        throw new Error('stubLlm: classify() is not used by writeBriefs');
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
  { id: 'acme', name: 'Acme AI', domain: 'acme.example', group: 'core', demo: true },
  { id: 'globex', name: 'Globex Robotics', domain: 'globex.example', group: 'core', demo: true },
  { id: 'initech', name: 'Initech Systems', domain: 'initech.example', group: 'core', demo: true },
];

function hiringEvent(accountId: string, url: string, date: string): SignalEvent {
  return {
    id: `hiring:${accountId}:${date}`,
    accountId,
    type: 'hiring',
    subtype: 'growth-eng',
    date,
    url,
    summary: 'Growth Engineer',
    confidence: 0.9,
    source: 'fixture',
    demo: true,
  };
}

function fundingEvent(accountId: string, url: string, date: string): SignalEvent {
  return {
    id: `funding:${accountId}:${date}`,
    accountId,
    type: 'funding',
    subtype: 'round',
    date,
    url,
    summary: `${accountId} raises a round`,
    confidence: 0.9,
    source: 'fixture',
    demo: true,
  };
}

function scoredFor(accountId: string, score: number, events: SignalEvent[]): ScoredAccount {
  return {
    accountId,
    score,
    contributions: events.map((e) => ({
      weightId: 'w1',
      eventId: e.id,
      eventUrl: e.url,
      eventDate: e.date,
      basePoints: 10,
      decayFactor: 1,
      points: 10,
    })),
    compoundsApplied: [],
  };
}

describe('writeBriefs', () => {
  it('a valid brief with a citation matching an event url populates citedUrls, leaves uncitedUrls empty', async () => {
    const acmeHiring = hiringEvent('acme', 'https://acme.example/careers/growth-eng', '2026-06-01');
    const events = [acmeHiring];
    const scored = [scoredFor('acme', 10, events)];

    const briefText =
      'SIGNALS\n' +
      `Acme AI is hiring a Growth Engineer (https://acme.example/careers/growth-eng, 2026-06-01).\n` +
      'WHY NOW\n' +
      `The growth hire signals a push into acquisition (https://acme.example/careers/growth-eng, 2026-06-01).\n` +
      'SUGGESTED ANGLE\n' +
      'Open with a note on scaling their growth motion.';

    const { client, calls } = stubLlm({ 'brief:acme': briefText });

    const briefs = await writeBriefs(scored, accounts, events, client, 3, '2026-07-06');

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('brief:acme');
    expect(calls[0].maxTokens).toBe(700);

    expect(briefs).toHaveLength(1);
    const brief = briefs[0];
    expect(brief.accountId).toBe('acme');
    expect(brief.text).toBe(briefText);
    expect(brief.citedUrls).toEqual([
      'https://acme.example/careers/growth-eng',
      'https://acme.example/careers/growth-eng',
    ]);
    expect(brief.uncitedUrls).toEqual([]);
  });

  it('a rogue URL not among the account events lands in uncitedUrls; the legitimate event url still lands in citedUrls, and a warning is logged', async () => {
    const acmeHiring = hiringEvent('acme', 'https://acme.example/careers/growth-eng', '2026-06-01');
    const events = [acmeHiring];
    const scored = [scoredFor('acme', 10, events)];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const briefText =
      'SIGNALS\n' +
      `Acme AI is hiring a Growth Engineer (https://acme.example/careers/growth-eng, 2026-06-01).\n` +
      'WHY NOW\n' +
      `They also raised funding (https://rogue.example/not-a-real-event, 2026-06-15).\n` +
      'SUGGESTED ANGLE\n' +
      'Open with a note on scaling their growth motion.';

    const { client } = stubLlm({ 'brief:acme': briefText });

    const briefs = await writeBriefs(scored, accounts, events, client, 3, '2026-07-06');

    expect(briefs[0].citedUrls).toEqual(['https://acme.example/careers/growth-eng']);
    expect(briefs[0].uncitedUrls).toEqual(['https://rogue.example/not-a-real-event']);
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(message).toContain('rogue.example');

    warnSpy.mockRestore();
  });

  it('accounts with score 0 are skipped: no LLM call, no brief produced', async () => {
    const acmeHiring = hiringEvent('acme', 'https://acme.example/careers/growth-eng', '2026-06-01');
    const scored = [scoredFor('acme', 10, [acmeHiring]), scoredFor('globex', 0, [])];

    const { client, calls } = stubLlm({
      'brief:acme': 'SIGNALS\nHiring (https://acme.example/careers/growth-eng, 2026-06-01).\nWHY NOW\nGrowth push.\nSUGGESTED ANGLE\nSay hi.',
    });

    const briefs = await writeBriefs(scored, accounts, [acmeHiring], client, 3, '2026-07-06');

    expect(briefs).toHaveLength(1);
    expect(briefs[0].accountId).toBe('acme');
    expect(calls.map((c) => c.id)).toEqual(['brief:acme']);
  });

  it('respects topN: only the first topN qualifying accounts get a brief', async () => {
    const acmeEvent = hiringEvent('acme', 'https://acme.example/careers/growth-eng', '2026-06-01');
    const globexEvent = fundingEvent('globex', 'https://globex.example/blog/round', '2026-06-05');
    const initechEvent = hiringEvent('initech', 'https://initech.example/careers/growth-eng', '2026-06-10');
    const events = [acmeEvent, globexEvent, initechEvent];
    const scored = [
      scoredFor('acme', 30, [acmeEvent]),
      scoredFor('globex', 20, [globexEvent]),
      scoredFor('initech', 10, [initechEvent]),
    ];

    const { client, calls } = stubLlm({
      'brief:acme': 'SIGNALS\nHiring (https://acme.example/careers/growth-eng, 2026-06-01).\nWHY NOW\nGrowth push.\nSUGGESTED ANGLE\nSay hi.',
      'brief:globex': 'SIGNALS\nFunded (https://globex.example/blog/round, 2026-06-05).\nWHY NOW\nCash to spend.\nSUGGESTED ANGLE\nSay hi.',
    });

    const briefs = await writeBriefs(scored, accounts, events, client, 2, '2026-07-06');

    expect(briefs.map((b) => b.accountId)).toEqual(['acme', 'globex']);
    expect(calls.map((c) => c.id)).toEqual(['brief:acme', 'brief:globex']);
  });

  it('the prompt includes the account name, dated URL-cited event bullets, and the exact instruction text', async () => {
    const acmeEvent = hiringEvent('acme', 'https://acme.example/careers/growth-eng', '2026-06-01');
    const scored = [scoredFor('acme', 10, [acmeEvent])];

    const { client, calls } = stubLlm({
      'brief:acme': 'SIGNALS\nHiring (https://acme.example/careers/growth-eng, 2026-06-01).\nWHY NOW\nGrowth push.\nSUGGESTED ANGLE\nSay hi.',
    });

    await writeBriefs(scored, accounts, [acmeEvent], client, 3, '2026-07-06');

    const prompt = calls[0].prompt;
    expect(prompt).toContain('Acme AI');
    expect(prompt).toContain('2026-06-01');
    expect(prompt).toContain('hiring/growth-eng');
    expect(prompt).toContain('Growth Engineer');
    expect(prompt).toContain('https://acme.example/careers/growth-eng');
    expect(prompt).toContain(
      'Write a short outreach brief with exactly three labeled sections: SIGNALS, WHY NOW, SUGGESTED ANGLE. ' +
        'Every factual claim must end with a citation in the form (URL, yyyy-mm-dd) using ONLY the URLs provided above. ' +
        'Do not invent facts, numbers, or names not present in the events. Plain text, no markdown headers.',
    );
  });
});

describe('renderBriefs', () => {
  const briefAccounts: Account[] = [
    { id: 'acme', name: 'Acme AI', domain: 'acme.example', group: 'core', demo: true },
  ];

  it('renders an account name header followed by indented brief text', () => {
    const briefs: Brief[] = [
      {
        accountId: 'acme',
        text: 'SIGNALS\nHiring (https://acme.example/careers/growth-eng, 2026-06-01).',
        citedUrls: ['https://acme.example/careers/growth-eng'],
        uncitedUrls: [],
      },
    ];

    const output = renderBriefs(briefs, briefAccounts);

    expect(output).toContain('Acme AI');
    expect(output).toContain('    SIGNALS');
    expect(output).toContain('    Hiring (https://acme.example/careers/growth-eng, 2026-06-01).');
    expect(output).not.toContain('⚠ uncited claims');
  });

  it('shows a warning line when uncitedUrls is non-empty', () => {
    const briefs: Brief[] = [
      {
        accountId: 'acme',
        text: 'SIGNALS\nHiring (https://rogue.example/x, 2026-06-01).',
        citedUrls: [],
        uncitedUrls: ['https://rogue.example/x'],
      },
    ];

    const output = renderBriefs(briefs, briefAccounts);

    expect(output).toContain('⚠ uncited claims');
  });

  it('shows a warning line when citedUrls is empty even with no uncitedUrls (no citations at all)', () => {
    const briefs: Brief[] = [
      {
        accountId: 'acme',
        text: 'SIGNALS\nSomething vague with no citation at all.',
        citedUrls: [],
        uncitedUrls: [],
      },
    ];

    const output = renderBriefs(briefs, briefAccounts);

    expect(output).toContain('⚠ uncited claims');
  });
});
