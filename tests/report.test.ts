import { describe, it, expect } from 'vitest';
import { renderHtmlReport, type ReportData } from '../src/output/report.js';
import type { Account, AuditRow, Brief, LiftRow, Playbook, ScoredAccount, SignalEvent } from '../src/types.js';

function baseAccounts(): Account[] {
  return [
    { id: 'acme', name: 'Acme', domain: 'acme.example', group: 'core', demo: true },
    { id: 'evil-corp', name: 'Evil <b>Corp', domain: 'evil.example', group: 'core', demo: true },
  ];
}

function baseAuditRows(): AuditRow[] {
  return [
    {
      accountId: 'acme',
      group: 'core',
      atsReachable: true,
      atsProvider: 'greenhouse',
      postingCount: 3,
      rssResolvable: true,
      notes: [],
      demo: true,
    },
    {
      accountId: 'evil-corp',
      group: 'core',
      atsReachable: false,
      rssResolvable: false,
      notes: ['no ats slug configured'],
      demo: true,
    },
  ];
}

function baseEvents(): SignalEvent[] {
  return [
    {
      id: 'hiring:acme:1',
      accountId: 'acme',
      type: 'hiring',
      subtype: 'growth-eng',
      date: '2026-06-01',
      url: 'https://acme.example/jobs/growth-eng',
      summary: 'Hiring a growth engineer',
      confidence: 0.9,
      source: 'fixture',
      demo: true,
    },
  ];
}

function baseScored(): ScoredAccount[] {
  return [
    {
      accountId: 'acme',
      score: 4.2,
      contributions: [
        {
          weightId: 'w-hiring-growth',
          eventId: 'hiring:acme:1',
          eventUrl: 'https://acme.example/jobs/growth-eng',
          eventDate: '2026-06-01',
          basePoints: 5,
          decayFactor: 0.84,
          points: 4.2,
        },
      ],
      compoundsApplied: [],
    },
    {
      accountId: 'evil-corp',
      score: 0,
      contributions: [],
      compoundsApplied: [],
    },
  ];
}

function baseBriefs(): Brief[] {
  return [
    {
      accountId: 'acme',
      text: 'SIGNALS\nHiring a growth engineer (https://acme.example/jobs/growth-eng, 2026-06-01).\nWHY NOW\nMomentum.\nSUGGESTED ANGLE\nLead with growth.',
      citedUrls: ['https://acme.example/jobs/growth-eng'],
      uncitedUrls: [],
    },
  ];
}

function basePlaybook(): Playbook {
  return {
    name: 'ai-startups',
    description: 'test playbook',
    halfLifeDays: { hiring: 45, funding: 90, press: 30 },
    weights: [
      {
        id: 'w-hiring-growth',
        signalType: 'hiring',
        subtype: 'growth-eng',
        points: 5,
        hypothesis: 'growth hires precede budget',
        status: 'untested',
      },
    ],
    compounds: [],
  };
}

function baseLift(): LiftRow[] {
  return [
    {
      weightId: 'w-hiring-growth',
      withAttempted: 4,
      withSucceeded: 2,
      withoutAttempted: 4,
      withoutSucceeded: 1,
      withRate: 0.5,
      withoutRate: 0.25,
      suggestion: 'supported',
      caveats: [],
    },
  ];
}

function baseData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    generatedAt: '2026-07-06',
    demo: true,
    auditRows: baseAuditRows(),
    scored: baseScored(),
    accounts: baseAccounts(),
    events: baseEvents(),
    briefs: baseBriefs(),
    lift: baseLift(),
    playbook: basePlaybook(),
    ...overrides,
  };
}

describe('renderHtmlReport', () => {
  it('starts with <!doctype html>', () => {
    const html = renderHtmlReport(baseData());
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('contains no <script tag anywhere', () => {
    const html = renderHtmlReport(baseData());
    expect(html).not.toContain('<script');
  });

  it('is fully self-contained: no external stylesheet, font, or script references', () => {
    const html = renderHtmlReport(baseData());
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*fonts\.(googleapis|gstatic)\.com/i);
  });

  it('escapes a dangerous account name (Evil <b>Corp) everywhere it appears', () => {
    const html = renderHtmlReport(baseData());
    expect(html).toContain('Evil &lt;b&gt;Corp');
    expect(html).not.toContain('Evil <b>Corp');
  });

  it('shows the demo banner (top and footer) when demo: true', () => {
    const html = renderHtmlReport(baseData({ demo: true }));
    const occurrences = html.split('⚠ synthetic demo data — fictional companies').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('omits the demo banner entirely when demo: false', () => {
    const html = renderHtmlReport(baseData({ demo: false }));
    expect(html).not.toContain('synthetic demo data');
  });

  it('renders every contribution event URL inside an href attribute', () => {
    const data = baseData();
    const html = renderHtmlReport(data);
    for (const scored of data.scored) {
      for (const c of scored.contributions) {
        expect(html).toContain(`href="${c.eventUrl}"`);
      }
    }
  });

  it('omits the lift section entirely when lift is undefined', () => {
    const html = renderHtmlReport(baseData({ lift: undefined }));
    expect(html).not.toMatch(/lift/i);
    expect(html).not.toContain('w-hiring-growth</td>');
  });

  it('includes the lift section, with caveats, when lift is present', () => {
    const withCaveat = baseLift();
    withCaveat[0] = { ...withCaveat[0], caveats: ['small n (with=2, without=2) — directional at best'] };
    const html = renderHtmlReport(baseData({ lift: withCaveat }));
    expect(html).toContain('small n (with=2, without=2) — directional at best');
    expect(html).toContain('supported');
  });

  it('renders the audit summary with per-group percentages and a per-account table', () => {
    const html = renderHtmlReport(baseData());
    expect(html).toMatch(/ATS 1\/2 \(50%\)/);
    expect(html).toContain('greenhouse');
  });

  it('renders each brief in its own <section>, converting \\n to <br>, with citations as visible URLs', () => {
    const html = renderHtmlReport(baseData());
    expect(html).toMatch(/<section[^>]*class="brief"[\s\S]*SIGNALS[\s\S]*<br>[\s\S]*WHY NOW/);
    expect(html).toContain('https://acme.example/jobs/growth-eng');
  });

  it('renders a footer with generatedAt and the playbook name', () => {
    const html = renderHtmlReport(baseData());
    expect(html).toContain('2026-07-06');
    expect(html).toContain('ai-startups');
  });

  it('renders scores ranked with score values and compound notes when present', () => {
    const scored = baseScored();
    scored[0] = {
      ...scored[0],
      compoundsApplied: [{ compoundId: 'c-funded-and-hiring-growth', multiplier: 1.5 }],
    };
    const html = renderHtmlReport(baseData({ scored }));
    expect(html).toContain('4.20');
    expect(html).toContain('c-funded-and-hiring-growth');
  });
});
