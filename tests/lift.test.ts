import { describe, it, expect } from 'vitest';
import { computeLift } from '../src/lift.js';
import type { ScoredAccount, OutcomeEvent, Playbook } from '../src/types.js';

const pb = {
  name: 't', description: 't', halfLifeDays: { hiring: 45, funding: 90, press: 30 },
  weights: [{ id: 'w1', signalType: 'hiring', points: 30, hypothesis: 'h', status: 'untested' }],
  compounds: [],
} as Playbook;
const scoredWith = (ids: string[]): ScoredAccount[] => ids.map(id => ({
  accountId: id, score: 30,
  contributions: [{ weightId: 'w1', eventId: 'e', eventUrl: 'u', eventDate: '2026-07-01', basePoints: 30, decayFactor: 1, points: 30 }],
  compoundsApplied: [],
}));
const scoredWithout = (ids: string[]): ScoredAccount[] => ids.map(id => ({
  accountId: id, score: 0, contributions: [], compoundsApplied: [],
}));
const out = (accountId: string, stage: string): OutcomeEvent => ({ accountId, stage, date: '2026-07-01' });

describe('computeLift', () => {
  it('computes rates and supports a weight with ≥1.5x lift at sufficient n', () => {
    const scored = [...scoredWith(['a', 'b', 'c']), ...scoredWithout(['d', 'e', 'f'])];
    const outcomes = [
      ...['a','b','c','d','e','f'].map(id => out(id, 'contacted')),
      out('a','replied'), out('b','replied'), out('d','replied'),
    ];
    const [row] = computeLift(scored, outcomes, pb);
    expect(row.withRate).toBeCloseTo(2/3, 5);
    expect(row.withoutRate).toBeCloseTo(1/3, 5);
    expect(row.suggestion).toBe('supported');
  });
  it('flags small n as inconclusive with a caveat', () => {
    const scored = [...scoredWith(['a']), ...scoredWithout(['d','e','f'])];
    const outcomes = [out('a','contacted'), out('a','replied'),
      ...['d','e','f'].map(id => out(id, 'contacted'))];
    const [row] = computeLift(scored, outcomes, pb);
    expect(row.suggestion).toBe('inconclusive');
    expect(row.caveats.some(c => /small n/.test(c))).toBe(true);
  });
  it('replied without contacted does not count as success', () => {
    const scored = [...scoredWith(['a','b','c']), ...scoredWithout(['d','e','f'])];
    const outcomes = [...['a','b','c','d','e','f'].map(id => out(id,'contacted')), out('x','replied')];
    const [row] = computeLift(scored, outcomes, pb);
    expect(row.withSucceeded).toBe(0);
  });
});
