import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { Account, AtsProvider, AuditRow, Posting, SignalEvent } from './types.js';
import { fetchPostings, probeBoard, AtsHttpError, type ProbeResult } from './sources/ats.js';
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

/** Default cap on postings classified per account in live mode, overridable via --max-postings. */
const DEFAULT_MAX_POSTINGS_PER_ACCOUNT = 40;

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

function demoPostingCount(accountId: string): number {
  const path = `${DEMO_POSTINGS_DIR}/${accountId}.json`;
  if (!existsSync(path)) return 0;
  const postings: Posting[] = JSON.parse(readFileSync(path, 'utf-8'));
  return postings.length;
}

/**
 * Patches real posting counts into demo audit rows. demoProbeBoard only ever
 * receives provider+slug (matching the real probeBoard signature), not the
 * account id the postings fixtures are keyed by, so it always reports
 * postingCount 0 by construction. Left unpatched, the audit table would claim
 * zero postings for boards the score table then cites postings from — an
 * internal contradiction in one output. Fix it here, at the wiring layer,
 * where the account id is available.
 */
function withDemoPostingCounts(rows: AuditRow[]): AuditRow[] {
  return rows.map((row) =>
    row.atsReachable ? { ...row, postingCount: demoPostingCount(row.accountId) } : row,
  );
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
  console.log(renderAuditTable(opts.demo ? withDemoPostingCounts(rows) : rows));
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
  const auditRows = withDemoPostingCounts(await auditAccounts(accounts, auditDeps));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Selects the `n` most recently published postings (by `publishedAt`,
 * descending); postings with no `publishedAt` (some ATS providers omit it —
 * see normalizeAshby) sort last, since we have no recency signal for them.
 * Pure and side-effect free so it can be unit-tested without any live calls.
 */
export function selectRecentPostings(postings: Posting[], n: number): Posting[] {
  return [...postings]
    .sort((a, b) => {
      if (!a.publishedAt && !b.publishedAt) return 0;
      if (!a.publishedAt) return 1;
      if (!b.publishedAt) return -1;
      return a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0;
    })
    .slice(0, n);
}

/**
 * Builds the live audit rows AND fetches each account's postings, in one pass
 * per account. probeBoard(...) internally calls fetchPostings and discards
 * the result, keeping only the count — calling it and then fetchPostings
 * again for classification meant every reachable board was fetched twice.
 * Here we call fetchPostings once per account, derive the audit row's
 * reachable/postingCount directly from that result (mirroring probeBoard's
 * own error handling exactly, so the audit table's shape is unchanged), and
 * hand the postings back for reuse by the classification step.
 */
async function auditAndFetchLive(
  accounts: Account[],
  delayMs = 150,
): Promise<{ rows: AuditRow[]; postingsByAccountId: Map<string, Posting[]> }> {
  const rows: AuditRow[] = [];
  const postingsByAccountId = new Map<string, Posting[]>();

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const notes: string[] = [];

    let atsReachable: boolean | null = null;
    let atsProvider: AuditRow['atsProvider'];
    let postingCount: number | undefined;

    if (account.ats) {
      atsProvider = account.ats.provider;
      try {
        const postings = await fetchPostings(account.ats.provider, account.ats.slug);
        atsReachable = true;
        postingCount = postings.length;
        postingsByAccountId.set(account.id, postings);
      } catch (err) {
        atsReachable = false;
        notes.push(
          err instanceof AtsHttpError ? 'ats board unreachable' : `ats error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      notes.push('no ats slug configured');
    }

    const rssResult = await resolveRss(account.domain, account.rss);
    if (!rssResult.resolvable) {
      notes.push('no rss feed found');
    }

    rows.push({
      accountId: account.id,
      group: account.group,
      atsReachable,
      atsProvider,
      postingCount,
      rssResolvable: rssResult.resolvable,
      notes,
      demo: account.demo,
    });

    if (i < accounts.length - 1) {
      await sleep(delayMs);
    }
  }

  return { rows, postingsByAccountId };
}

/**
 * Live scoring pipeline: real accounts, live ATS fetches, live Haiku
 * classification. No funding/press sources yet (those land Evening 2), so
 * this scores hiring signal only. asOf is resolved to today here at the CLI
 * layer — scoreAccounts itself stays pure and never calls Date.now().
 *
 * Requires ANTHROPIC_API_KEY; throws (before any network call) if it is
 * unset so callers fail closed rather than burning a live ATS fetch first.
 *
 * Classifying every posting costs one live Haiku call each, so postings are
 * capped to the `maxPostings` (default DEFAULT_MAX_POSTINGS_PER_ACCOUNT) most
 * recent per account before classification, and a preflight line reports the
 * total call count before spending it.
 */
export async function runScoreLive(opts: {
  accounts: string;
  playbook: string;
  maxPostings?: number;
}): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set; live scoring requires it to classify hiring postings.',
    );
  }

  const accounts = loadAccounts(opts.accounts);
  const maxPostings = opts.maxPostings ?? DEFAULT_MAX_POSTINGS_PER_ACCOUNT;

  const { rows: auditRows, postingsByAccountId } = await auditAndFetchLive(accounts);
  const auditOutput = renderAuditTable(auditRows);

  const cappedByAccountId = new Map<string, Posting[]>();
  let totalToClassify = 0;
  let totalSkipped = 0;
  for (const [accountId, postings] of postingsByAccountId) {
    const capped = selectRecentPostings(postings, maxPostings);
    cappedByAccountId.set(accountId, capped);
    totalToClassify += capped.length;
    totalSkipped += postings.length - capped.length;
  }
  const accountsToClassify = [...cappedByAccountId.values()].filter((p) => p.length > 0).length;

  console.log(
    `about to classify ${totalToClassify} postings across ${accountsToClassify} accounts (1 LLM call each)`,
  );
  if (totalSkipped > 0) {
    console.log(
      `skipped ${totalSkipped} posting(s) beyond the ${maxPostings}-per-account cap (override with --max-postings)`,
    );
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const llm = liveLlm(CLASSIFY_MODEL);
  const events: SignalEvent[] = [];
  for (const account of accounts) {
    const postings = cappedByAccountId.get(account.id);
    if (!postings || postings.length === 0 || !account.ats) continue;
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
  .option(
    '--max-postings <n>',
    `cap postings classified per account, most recent first (live mode only)`,
    (value: string) => Number(value),
    DEFAULT_MAX_POSTINGS_PER_ACCOUNT,
  )
  .action(
    async (opts: { accounts: string; playbook: string; demo?: boolean; maxPostings: number }) => {
      if (opts.demo) {
        if (opts.accounts !== DEFAULT_ACCOUNTS_PATH) {
          console.warn('--accounts is ignored when --demo is set');
        }
        if (opts.playbook !== DEFAULT_PLAYBOOK_PATH) {
          console.warn('--playbook is ignored when --demo is set');
        }
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
    },
  );

/**
 * True iff this module is the process entry point (invoked directly, e.g.
 * `tsx src/cli.ts` or the built bin), as opposed to being imported for its
 * exports (tests). Compares via pathToFileURL rather than a raw
 * `file://${argv1}` template — the naive template silently fails to match
 * whenever the path contains a space or other character import.meta.url
 * percent-encodes but argv[1] doesn't, which made the CLI a silent no-op
 * (exit 0, no output) when run from a directory with a space in its name.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  return !!argv1 && metaUrl === pathToFileURL(argv1).href;
}

// Only run the CLI when this file is the process entry point — importing it
// for its exports (tests) must not trigger argv parsing as a side effect.
if (isMainModule(import.meta.url, process.argv[1])) {
  program.parseAsync(process.argv);
}
