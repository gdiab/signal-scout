import { describe, it, expect } from 'vitest';
import { scoreAccounts } from '../src/scoring.js';
import type { Account, SignalEvent, Playbook } from '../src/types.js';

const pb: Playbook = {
  name: 't', description: 't',
  halfLifeDays: { hiring: 45, funding: 90, press: 30 },
  weights: [
    { id: 'w-growth-eng', signalType: 'hiring', subtype: 'growth-eng', points: 30, hypothesis: 'h', status: 'untested' },
    { id: 'w-generic-eng', signalType: 'hiring', subtype: 'generic-eng', points: 5, hypothesis: 'h', status: 'untested' },
    { id: 'w-funding', signalType: 'funding', points: 25, hypothesis: 'h', status: 'untested' },
  ],
  compounds: [
    { id: 'c1', requiresWeightIds: ['w-funding', 'w-growth-eng'], withinDays: 90, multiplier: 1.5, hypothesis: 'h', status: 'untested' },
  ],
};
const acct = (id: string): Account => ({ id, name: id, domain: `${id}.example`, group: 'core', demo: true });
const ev = (id: string, accountId: string, type: 'hiring'|'funding'|'press', subtype: string, date: string): SignalEvent =>
  ({ id, accountId, type, subtype, date, url: `https://x.example/${id}`, summary: 's', confidence: 1, source: 'fixture', demo: true });

describe('scoreAccounts', () => {
  it('applies half-life decay: 45-day-old hiring event at half points', () => {
    const r = scoreAccounts([acct('a')], [ev('e1','a','hiring','growth-eng','2026-05-22')], pb, '2026-07-06');
    expect(r[0].contributions[0].decayFactor).toBeCloseTo(0.5, 5);
    expect(r[0].score).toBeCloseTo(15, 5);
  });
  it('same-day event has decayFactor 1', () => {
    const r = scoreAccounts([acct('a')], [ev('e1','a','hiring','growth-eng','2026-07-06')], pb, '2026-07-06');
    expect(r[0].score).toBeCloseTo(30, 5);
  });
  it('event matches only its subtype weight, and only one weight', () => {
    const r = scoreAccounts([acct('a')], [ev('e1','a','hiring','generic-eng','2026-07-06')], pb, '2026-07-06');
    expect(r[0].contributions).toHaveLength(1);
    expect(r[0].contributions[0].weightId).toBe('w-generic-eng');
  });
  it('compound multiplies whole score when both events within window', () => {
    const r = scoreAccounts([acct('a')],
      [ev('e1','a','hiring','growth-eng','2026-07-06'), ev('e2','a','funding','round','2026-06-06')], pb, '2026-07-06');
    // hiring: 30*1 = 30; funding age 30d, halfLife 90 -> 25*0.5^(1/3) ≈ 19.8425; sum ≈ 49.8425; ×1.5 ≈ 74.764
    expect(r[0].compoundsApplied).toHaveLength(1);
    expect(r[0].score).toBeCloseTo((30 + 25 * Math.pow(0.5, 30/90)) * 1.5, 3);
  });
  it('compound does NOT apply when events outside window', () => {
    const r = scoreAccounts([acct('a')],
      [ev('e1','a','hiring','growth-eng','2026-07-06'), ev('e2','a','funding','round','2026-01-01')], pb, '2026-07-06');
    expect(r[0].compoundsApplied).toHaveLength(0);
  });
  it('future-dated event contributes 0', () => {
    const r = scoreAccounts([acct('a')], [ev('e1','a','hiring','growth-eng','2026-08-01')], pb, '2026-07-06');
    expect(r[0].score).toBe(0);
  });
  it('sorts accounts by score desc and every contribution carries url+date lineage', () => {
    const r = scoreAccounts([acct('a'), acct('b')],
      [ev('e1','a','hiring','generic-eng','2026-07-06'), ev('e2','b','hiring','growth-eng','2026-07-06')], pb, '2026-07-06');
    expect(r.map(x => x.accountId)).toEqual(['b','a']);
    expect(r.every(x => x.contributions.every(c => c.eventUrl && c.eventDate))).toBe(true);
  });
  it('future-dated event cannot activate a compound', () => {
    const r = scoreAccounts([acct('a')],
      [ev('e1','a','hiring','growth-eng','2026-08-01'), ev('e2','a','funding','round','2026-07-01')], pb, '2026-07-06');
    expect(r[0].compoundsApplied).toHaveLength(0);
    expect(r[0].score).toBeCloseTo(25 * Math.pow(0.5, 5/90), 5);
  });
});
