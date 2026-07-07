import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import type { Account, AtsProvider, Posting, SignalEvent } from './types.js';
import { fetchPostings, probeBoard, type ProbeResult } from './sources/ats.js';
import { resolveRss, type RssResult } from './sources/rss.js';
import { auditAccounts, type AuditDeps } from './audit.js';
import { renderAuditTable, renderScoreTable } from './output/table.js';
import { classifyPostings } from './signals/hiring.js';
import { fixtureLlm, liveLlm, CLASSIFY_MODEL } from './llm.js';
import { loadPlaybook } from './playbook.js';
import { scoreAccounts } from './scoring.js';

const DEFAULT_ACCOUNTS_PATH = 'accounts/ai-startups.json';
const DEFAULT_PLAYBOOK_PATH = 'playbooks/ai-startups.json';
const DEMO_ACCOUNTS_PATH = 'fixtures/demo/accounts.json';
const DEMO_POSTINGS_DIR = 'fixtures/demo/postings';
const DEMO_LLM_PATH = 'fixtures/demo/llm/hiring-classify.json';
const DEMO_SIGNALS_PATH = 'fixtures/demo/signals.jsonl';
// Pinned so demo output is deterministic across runs/machines — the demo
// fixtures (postings, signals.jsonl) were authored relative to this date.
const DEMO_AS_OF = '2026-07-06';

function loadAccounts(path: string): Account[] {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadJsonl(path: string): SignalEvent[] {
  const raw = readFileSync(path, 'utf-8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

/**
 * Demo-mode ATS probe: never touches the network. It is only ever invoked by
 * auditAccounts for accounts that already have an `ats` entry configured, so
 * "reachable" here means "demo account declares a board" by construction.
 */
export async function demoProbeBoard(
  _provider: AtsProvider,
  _slug: string,
  _fetchImpl?: typeof fetch,
): Promise<ProbeResult> {
  return { reachable: true, postingCount: 0 };
}

/** Demo-mode RSS probe: resolvable iff the account declares an rss URL. No network. */
export async function demoProbeRss(
  _domain: string,
  rss?: string,
  _fetchImpl?: typeof fetch,
): Promise<RssResult> {
  return rss ? { resolvable: true, feedUrl: rss } : { resolvable: false };
}

async function runAudit(opts: { accounts: string; demo?: boolean }): Promise<void> {
  if (opts.demo && !existsSync(DEMO_ACCOUNTS_PATH)) {
    console.log('demo fixtures not yet available');
    process.exitCode = 1;
    return;
  }

  const accountsPath = opts.demo ? DEMO_ACCOUNTS_PATH : opts.accounts;
  const accounts = loadAccounts(accountsPath);

  const deps: AuditDeps = opts.demo
    ? { probeBoard: demoProbeBoard, probeRss: demoProbeRss, delayMs: 0 }
    : { probeBoard, probeRss: resolveRss };

  const rows = await auditAccounts(accounts, deps);
  console.log(renderAuditTable(rows));
}

/**
 * Full demo pipeline, in-process: demo accounts -> mocked audit -> classify
 * each core account's recorded postings via fixtureLlm -> merge with the
 * pre-made funding/press events in signals.jsonl -> score against the
 * ai-startups playbook, asOf pinned to the date the fixtures were authored
 * for. Zero network, zero credentials, fully deterministic. Returns the full
 * output string (audit summary + ranked score table) rather than printing
 * directly, so it can be exercised end-to-end from tests.
 */
export async function runScoreDemo(): Promise<string> {
  const accounts = loadAccounts(DEMO_ACCOUNTS_PATH);

  const auditDeps: AuditDeps = { probeBoard: demoProbeBoard, probeRss: demoProbeRss, delayMs: 0 };
  const auditRows = await auditAccounts(accounts, auditDeps);
  const auditOutput = renderAuditTable(auditRows);

  const llm = fixtureLlm(DEMO_LLM_PATH);
  const hiringEvents: SignalEvent[] = [];
  for (const account of accounts) {
    if (account.group !== 'core') continue; // only core accounts have recorded postings fixtures
    const postingsPath = `${DEMO_POSTINGS_DIR}/${account.id}.json`;
    const postings: Posting[] = JSON.parse(readFileSync(postingsPath, 'utf-8'));
    const events = await classifyPostings(account.id, postings, llm, DEMO_AS_OF, 'fixture');
    hiringEvents.push(...events);
  }

  const fundingAndPressEvents = loadJsonl(DEMO_SIGNALS_PATH);
  const events = [...hiringEvents, ...fundingAndPressEvents];

  const playbook = loadPlaybook(DEFAULT_PLAYBOOK_PATH);
  const scored = scoreAccounts(accounts, events, playbook, DEMO_AS_OF);
  const scoreOutput = renderScoreTable(scored, accounts, events);

  return `${auditOutput}\n\n${scoreOutput}`;
}

/**
 * Live scoring pipeline: real accounts, live ATS fetches, live Haiku
 * classification. No funding/press sources yet (those land Evening 2), so
 * this scores hiring signal only. asOf is resolved to today here at the CLI
 * layer — scoreAccounts itself stays pure and never calls Date.now().
 *
 * Requires ANTHROPIC_API_KEY; throws (before any network call) if it is
 * unset so callers fail closed rather than burning a live ATS fetch first.
 */
export async function runScoreLive(opts: { accounts: string; playbook: string }): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set; live scoring requires it to classify hiring postings.',
    );
  }

  const accounts = loadAccounts(opts.accounts);

  const auditDeps: AuditDeps = { probeBoard, probeRss: resolveRss };
  const auditRows = await auditAccounts(accounts, auditDeps);
  const auditOutput = renderAuditTable(auditRows);

  const asOf = new Date().toISOString().slice(0, 10);
  const llm = liveLlm(CLASSIFY_MODEL);
  const events: SignalEvent[] = [];
  for (const account of accounts) {
    if (!account.ats) continue;
    const postings = await fetchPostings(account.ats.provider, account.ats.slug);
    const classified = await classifyPostings(account.id, postings, llm, asOf, account.ats.provider);
    events.push(...classified);
  }

  const playbook = loadPlaybook(opts.playbook);
  const scored = scoreAccounts(accounts, events, playbook, asOf);
  const scoreOutput = renderScoreTable(scored, accounts, events);

  return `${auditOutput}\n\n${scoreOutput}`;
}

const program = new Command();
program.name('signal-scout').description('Growth-signal engine with a closed experiment loop.');

program
  .command('audit')
  .description('Audit an account list for signal AVAILABILITY (ATS boards, RSS feeds).')
  .option('--accounts <path>', 'path to accounts JSON', DEFAULT_ACCOUNTS_PATH)
  .option('--demo', 'run against synthetic demo fixtures, no network', false)
  .action(async (opts: { accounts: string; demo?: boolean }) => {
    await runAudit(opts);
  });

program
  .command('score')
  .description('Score accounts against a playbook: hiring, funding, and press signal with recency decay.')
  .option('--accounts <path>', 'path to accounts JSON', DEFAULT_ACCOUNTS_PATH)
  .option('--playbook <path>', 'path to playbook JSON', DEFAULT_PLAYBOOK_PATH)
  .option('--demo', 'run against synthetic demo fixtures, no network, no API key required', false)
  .action(async (opts: { accounts: string; playbook: string; demo?: boolean }) => {
    if (opts.demo) {
      if (!existsSync(DEMO_ACCOUNTS_PATH)) {
        console.log('demo fixtures not yet available');
        process.exitCode = 1;
        return;
      }
      console.log(await runScoreDemo());
      return;
    }

    try {
      console.log(await runScoreLive(opts));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// Only run the CLI when this file is the process entry point — importing it
// for its exports (tests) must not trigger argv parsing as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parseAsync(process.argv);
}
