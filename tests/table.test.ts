import { describe, it, expect } from 'vitest';
import { renderReviewQueueSummary } from '../src/output/table.js';
import type { ReviewItem } from '../src/types.js';

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
