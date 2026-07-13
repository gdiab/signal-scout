import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScoreDemo, runScoreLive, runLiftDemo, runLiftLive } from '../src/cli.js';

// Guard against accidental live network anywhere in this suite: if any code
// path falls back to the global fetch instead of an injected fake, fail loudly.
// This is the strongest proof available that demo mode makes zero network calls.
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected live fetch in demo mode');
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('runScoreDemo (end-to-end, in-process)', () => {
  it('produces an audit summary + ranked score table with lineage, entirely offline', async () => {
    const output = await runScoreDemo();

    // Synthetic-data footer must be present.
    expect(output).toContain('⚠ synthetic demo data — fictional companies');

    const lines = output.split('\n');

    // Find the ranked score rows: lines starting with a rank number "1 " etc.
    const rankLineRegex = /^\d+\s+/;
    const rankLines = lines.filter((l) => rankLineRegex.test(l));
    expect(rankLines.length).toBeGreaterThan(0);

    // Extract scores in the order they appear to assert descending order.
    const scores = rankLines.map((l) => {
      const match = l.match(/^\d+\s+\S.*?\s+(-?\d+\.\d{2})\s*$/);
      expect(match, `line did not match expected rank format: "${l}"`).toBeTruthy();
      return Number(match![1]);
    });
    expect(scores.length).toBeGreaterThan(0);
    expect(scores[0]).toBeGreaterThan(0);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }

    // Every contribution line must carry a url and a date.
    const contributionLines = lines.filter((l) => /decay×/.test(l));
    expect(contributionLines.length).toBeGreaterThan(0);
    for (const line of contributionLines) {
      expect(line).toMatch(/https:\/\/\S+\.example\/\S+/);
      expect(line).toMatch(/\d{4}-\d{2}-\d{2}/);
    }

    // Exactly one compound application across the whole output.
    const compoundLines = lines.filter((l) => /compound ×/.test(l));
    expect(compoundLines).toHaveLength(1);
    expect(compoundLines[0]).toContain('c-funded-and-hiring-growth');

    // Contrast accounts appear only in the audit, never in the ranked score
    // table (SPEC) — they carry no events and would otherwise show as
    // wasted-looking 0.00 rows.
    expect(output).toContain('meridian-imaging');
    expect(output).toContain('cartway-freight');
    const scoreSectionStart = lines.findIndex((l) => rankLineRegex.test(l));
    const scoreSectionLines = lines.slice(scoreSectionStart, scoreSectionStart + rankLines.length);
    expect(scoreSectionLines.join('\n')).not.toMatch(/Meridian Imaging Partners|Cartway Freight Solutions/);

    // Funding now flows through the same matchArticles pipeline live mode
    // uses (fixtures/demo/feeds/*.json -> press-match.json), not a pre-made
    // signals.jsonl — at least one funding ('round' subtype) contribution
    // line must be present, with a .example lineage url.
    const fundingLines = contributionLines.filter((l) => /\bround\b/.test(l));
    expect(fundingLines.length).toBeGreaterThan(0);
    for (const line of fundingLines) {
      expect(line).toMatch(/https:\/\/\S+\.example\/\S+/);
    }

    // The one low-confidence sweep match must surface in a review-queue
    // summary, never silently matched (ADR 0001).
    expect(output).toContain('review queue (needs a human):');
    expect(output).toMatch(/\? .+ — loomwright \(0\.45\)/);

    // The loop closes in one command: the lift table is appended, with at
    // least one supported and at least one small-n-caveated inconclusive
    // suggestion (the demo outcome fixture is authored to guarantee both),
    // plus the proposals footer.
    expect(output).toMatch(/w-funding-180 .*suggestion=supported/);
    expect(output).toMatch(/suggestion=inconclusive/);
    expect(output).toMatch(/⚠ small n \(with=\d+, without=\d+\) — directional at best/);
    expect(output).toContain("suggestions are proposals for the playbook's weight `status` fields");
  });

  it('when reportPath is given, writes a self-contained HTML report reusing the same computed pipeline data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-scout-report-'));
    const reportPath = join(dir, 'report.html');

    const output = await runScoreDemo({ reportPath });
    const html = readFileSync(reportPath, 'utf-8');

    // Terminal output is unaffected by the report being written.
    expect(output).toContain('⚠ synthetic demo data — fictional companies');

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).toContain('⚠ synthetic demo data — fictional companies');
    // At least one contribution's citation url must be a clickable href — the
    // report renders the same lineage the terminal table does.
    expect(html).toMatch(/href="https:\/\/\S+\.example\/\S+"/);
    // The lift section (computed from the same recorded outcome fixture as
    // the terminal table above) is present, not omitted.
    expect(html).toContain('w-funding-180');
  });

  it('writes no report file when reportPath is omitted', async () => {
    // An accidental default write would land at the CLI's default path,
    // report.html in cwd. That file is a generated, gitignored artifact, so
    // removing any stale one from a previous manual smoke run is safe — and
    // makes the "nothing was created" assertion below actually bite.
    const defaultPath = 'report.html';
    rmSync(defaultPath, { force: true });

    const output = await runScoreDemo();

    expect(output).toContain('⚠ synthetic demo data — fictional companies');
    expect(existsSync(defaultPath)).toBe(false);
  });
});

describe('runLiftDemo (end-to-end, in-process)', () => {
  it('renders the standalone lift table with a supported and an inconclusive suggestion, offline, with the synthetic footer', async () => {
    const output = await runLiftDemo();

    expect(output).toMatch(/w-funding-180 .*suggestion=supported/);
    expect(output).toMatch(/suggestion=inconclusive/);
    expect(output).toMatch(/⚠ small n \(with=\d+, without=\d+\) — directional at best/);
    expect(output).toContain("suggestions are proposals for the playbook's weight `status` fields");
    expect(output).toContain('⚠ synthetic demo data — fictional companies');
  });
});

describe('runLiftLive missing-file errors', () => {
  it('names the missing signals snapshot and says to run score first', () => {
    expect(() =>
      runLiftLive({
        events: 'fixtures/demo/events.jsonl',
        signals: 'no-such-signals.jsonl',
        playbook: 'playbooks/ai-startups.json',
        accounts: 'accounts/ai-startups.json',
      }),
    ).toThrow(/no-such-signals\.jsonl.*run 'score' first to capture signal events/);
  });

  it('names the missing outcome log', () => {
    expect(() =>
      runLiftLive({
        events: 'no-such-events.jsonl',
        signals: 'fixtures/demo/events.jsonl',
        playbook: 'playbooks/ai-startups.json',
        accounts: 'accounts/ai-startups.json',
      }),
    ).toThrow(/outcome log not found: no-such-events\.jsonl/);
  });
});

describe('runScoreLive key guard', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects before any network call when ANTHROPIC_API_KEY is unset, naming the variable', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined as unknown as string);
    await expect(
      runScoreLive({ accounts: 'accounts/ai-startups.json', playbook: 'playbooks/ai-startups.json' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('rejects a bad --playbook path before any network call, not after minutes of ATS fetching', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await expect(
      runScoreLive({ accounts: 'accounts/ai-startups.json', playbook: 'no-such-playbook.json' }),
    ).rejects.toThrow(/no-such-playbook\.json/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('demo fixture integrity', () => {
  const accounts: Array<{ id: string; domain: string; group: string; rss?: string; demo?: boolean }> = JSON.parse(
    readFileSync('fixtures/demo/accounts.json', 'utf-8'),
  );

  it('every account domain (and rss host, when present) ends .example and is marked demo:true', () => {
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account.domain.endsWith('.example')).toBe(true);
      expect(account.demo).toBe(true);
      if (account.rss !== undefined) {
        const rssHost = new URL(account.rss).host;
        expect(rssHost.endsWith('.example')).toBe(true);
      }
    }
  });

  it('every posting across every core account has a .example url host and demo:true', () => {
    const postingFiles = readdirSync('fixtures/demo/postings');
    expect(postingFiles.length).toBeGreaterThan(0);
    for (const file of postingFiles) {
      const postings: Array<{ url: string; demo?: boolean }> = JSON.parse(
        readFileSync(`fixtures/demo/postings/${file}`, 'utf-8'),
      );
      for (const posting of postings) {
        const host = new URL(posting.url).host;
        expect(host.endsWith('.example')).toBe(true);
        expect(posting.demo).toBe(true);
      }
    }
  });

  it('every core account has a feeds fixture, and every item in it has a .example url host', () => {
    const coreAccounts = accounts.filter((a) => a.group === 'core');
    expect(coreAccounts.length).toBeGreaterThan(0);
    for (const account of coreAccounts) {
      const items: Array<{ url: string }> = JSON.parse(
        readFileSync(`fixtures/demo/feeds/${account.id}.json`, 'utf-8'),
      );
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const host = new URL(item.url).host;
        expect(host.endsWith('.example')).toBe(true);
      }
    }
  });

  it('every outcome row in events.jsonl is demo:true, has a known stage, and references a core account', () => {
    const coreIds = new Set(accounts.filter((a) => a.group === 'core').map((a) => a.id));
    const knownStages = new Set(['scored', 'contacted', 'replied', 'applied', 'responded']);
    const rows: Array<{ accountId: string; stage: string; date: string; demo?: boolean }> = readFileSync(
      'fixtures/demo/events.jsonl',
      'utf-8',
    )
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.demo).toBe(true);
      expect(knownStages.has(row.stage)).toBe(true);
      expect(coreIds.has(row.accountId)).toBe(true);
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('general-sweep.json items all resolve to a .example url host', () => {
    const items: Array<{ url: string }> = JSON.parse(
      readFileSync('fixtures/demo/feeds/general-sweep.json', 'utf-8'),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const host = new URL(item.url).host;
      expect(host.endsWith('.example')).toBe(true);
    }
  });
});
