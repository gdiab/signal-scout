import { describe, it, expect } from 'vitest';
import { renderLiftTable, renderReviewQueueSummary } from '../src/output/table.js';
import type { LiftRow, Playbook, ReviewItem } from '../src/types.js';

describe('renderReviewQueueSummary', () => {
  it('renders a header line followed by one "? title — accountId (confidence) reason" line per item', () => {
    const items: ReviewItem[] = [
      {
        url: 'https://news.example/workflow-startup-name-confusion',
        title: 'Confusion Grows Around Similarly Named Workflow Startups Including Loomwright',
        accountId: 'loomwright',
        confidence: 0.45,
        reason: 'low-confidence match (0.45 < 0.6)',
      },
    ];

    const output = renderReviewQueueSummary(items);

    expect(output).toBe(
      'review queue (needs a human):\n' +
        '? Confusion Grows Around Similarly Named Workflow Startups Including Loomwright — loomwright (0.45) low-confidence match (0.45 < 0.6)',
    );
  });

  it('renders one line per item, in input order, header first', () => {
    const items: ReviewItem[] = [
      {
        url: 'https://news.example/a',
        title: 'Article A',
        accountId: 'acme',
        confidence: 0.5,
        reason: 'low-confidence match (0.5 < 0.6)',
      },
      {
        url: 'https://news.example/b',
        title: 'Article B',
        accountId: 'globex',
        confidence: 0.55,
        reason: 'low-confidence match (0.55 < 0.6)',
      },
    ];

    const output = renderReviewQueueSummary(items);
    const lines = output.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('review queue (needs a human):');
    expect(lines[1]).toBe('? Article A — acme (0.5) low-confidence match (0.5 < 0.6)');
    expect(lines[2]).toBe('? Article B — globex (0.55) low-confidence match (0.55 < 0.6)');
  });

  it('returns just the header for an empty queue', () => {
    expect(renderReviewQueueSummary([])).toBe('review queue (needs a human):');
  });
});

describe('renderLiftTable', () => {
  const playbook = {
    name: 't', description: 't', halfLifeDays: { hiring: 45, funding: 90, press: 30 },
    hiringLabels: [],
    weights: [
      { id: 'w1', signalType: 'hiring', points: 30, hypothesis: 'h', status: 'untested' },
      { id: 'w2', signalType: 'funding', points: 25, hypothesis: 'h', status: 'supported' },
    ],
    compounds: [],
  } as Playbook;

  const row = (overrides: Partial<LiftRow>): LiftRow => ({
    weightId: 'w1',
    withAttempted: 3, withSucceeded: 2,
    withoutAttempted: 3, withoutSucceeded: 1,
    withRate: 2 / 3, withoutRate: 1 / 3,
    suggestion: 'supported',
    caveats: [],
    ...overrides,
  });

  it('renders one line per weight with current status, with/without "x/y (r%)" cells, and the suggestion', () => {
    const rows = [row({}), row({ weightId: 'w2', suggestion: 'inconclusive' })];
    const lines = renderLiftTable(rows, playbook).split('\n');

    expect(lines[0]).toContain('w1');
    expect(lines[0]).toContain('status=untested');
    expect(lines[0]).toContain('with 2/3 (67%)');
    expect(lines[0]).toContain('without 1/3 (33%)');
    expect(lines[0]).toContain('suggestion=supported');
    expect(lines[1]).toContain('w2');
    expect(lines[1]).toContain('status=supported');
    expect(lines[1]).toContain('suggestion=inconclusive');
  });

  it('renders caveats indented under their weight line and null rates as n/a, never 0%', () => {
    const rows = [row({
      withAttempted: 0, withSucceeded: 0, withRate: null,
      suggestion: 'inconclusive',
      caveats: ['small n (with=0, without=3) — directional at best'],
    })];
    const output = renderLiftTable(rows, playbook);

    expect(output).toContain('with 0/0 (n/a)');
    expect(output).toContain('    ⚠ small n (with=0, without=3) — directional at best');
  });

  it('ends with a footer explaining suggestions are proposals for the playbook status fields', () => {
    const output = renderLiftTable([row({})], playbook);
    const lines = output.split('\n');
    expect(lines[lines.length - 1]).toBe(
      "suggestions are proposals for the playbook's weight `status` fields — review and apply by hand, this command never edits the playbook file.",
    );
  });
});
