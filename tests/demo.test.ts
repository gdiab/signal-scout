import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { runScoreDemo, runScoreLive } from '../src/cli.js';

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
});

describe('demo fixture integrity', () => {
  const accounts: Array<{ id: string; domain: string; rss?: string; demo?: boolean }> = JSON.parse(
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

  it('every signal event in signals.jsonl is demo:true with a .example url host', () => {
    const raw = readFileSync('fixtures/demo/signals.jsonl', 'utf-8').trim();
    const events = raw.split('\n').map((line) => JSON.parse(line));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.demo).toBe(true);
      const host = new URL(event.url).host;
      expect(host.endsWith('.example')).toBe(true);
    }
  });
});
