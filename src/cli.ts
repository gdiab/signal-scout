import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { Account, AtsProvider, AuditRow, FeedItem, Posting, ReviewItem, SignalEvent } from './types.js';
import { fetchPostings, probeBoard, AtsHttpError, type ProbeResult } from './sources/ats.js';
import { resolveRss, fetchFeedItems, type RssResult } from './sources/rss.js';
import { auditAccounts, type AuditDeps } from './audit.js';
import { renderAuditTable, renderScoreTable, renderReviewQueueSummary } from './output/table.js';
import { classifyPostings } from './signals/hiring.js';
import { matchArticles, type CandidateArticle } from './signals/press.js';
import { fixtureLlm, liveLlm, CLASSIFY_MODEL } from './llm.js';
import { loadPlaybook } from './playbook.js';
import { scoreAccounts } from './scoring.js';

const DEFAULT_ACCOUNTS_PATH = 'accounts/ai-startups.json';
const DEFAULT_PLAYBOOK_PATH = 'playbooks/ai-startups.json';
const DEMO_ACCOUNTS_PATH = 'fixtures/demo/accounts.json';
const DEMO_POSTINGS_DIR = 'fixtures/demo/postings';
const DEMO_LLM_PATH = 'fixtures/demo/llm/hiring-classify.json';
const DEMO_FEEDS_DIR = 'fixtures/demo/feeds';
const DEMO_SWEEP_PATH = 'fixtures/demo/feeds/general-sweep.json';
const DEMO_PRESS_MATCH_PATH = 'fixtures/demo/llm/press-match.json';
// Pinned so demo output is deterministic across runs/machines — the demo
// fixtures (postings, feed items) were authored relative to this date.
const DEMO_AS_OF = '2026-07-06';

/** Real, live RSS/Atom feeds swept for press/funding news outside our tracked accounts' own feeds. */
const GENERAL_FEEDS_PATH = 'feeds/general.json';
const REVIEW_QUEUE_PATH = 'review-queue.jsonl';
const SIGNAL_EVENTS_PATH = 'signal-events.jsonl';

/** Default cap on postings classified per account in live mode, overridable via --max-postings. */
const DEFAULT_MAX_POSTINGS_PER_ACCOUNT = 40;
/** Default cap on articles matched per feed in live mode, overridable via --max-articles. */
const DEFAULT_MAX_ARTICLES_PER_FEED = 20;
/** Delay between sequential live requests to the same class of external host (ATS/RSS probes, feed fetches). */
const POLITENESS_DELAY_MS = 150;

function loadAccounts(path: string): Account[] {
  return JSON.parse(readFileSync(path, 'utf-8'));
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
 * each core account's recorded postings via fixtureLlm -> build press/funding
 * candidates from each core account's own recorded feed fixture plus a
 * general-sweep fixture -> match them via fixtureLlm (the exact same
 * matchArticles pipeline live mode uses) -> merge hiring + press/funding
 * events -> score against the ai-startups playbook, asOf pinned to the date
 * the fixtures were authored for. Zero network, zero credentials, fully
 * deterministic. Returns the full output string (audit summary + ranked
 * score table + review-queue summary, when non-empty) rather than printing
 * directly, so it can be exercised end-to-end from tests.
 */
export async function runScoreDemo(): Promise<string> {
  const accounts = loadAccounts(DEMO_ACCOUNTS_PATH);
  const coreAccounts = accounts.filter((a) => a.group === 'core');

  const auditDeps: AuditDeps = { probeBoard: demoProbeBoard, probeRss: demoProbeRss, delayMs: 0 };
  const auditRows = withDemoPostingCounts(await auditAccounts(accounts, auditDeps));
  const auditOutput = renderAuditTable(auditRows);

  const hiringLlm = fixtureLlm(DEMO_LLM_PATH);
  const hiringEvents: SignalEvent[] = [];
  for (const account of coreAccounts) {
    const postingsPath = `${DEMO_POSTINGS_DIR}/${account.id}.json`;
    const postings: Posting[] = JSON.parse(readFileSync(postingsPath, 'utf-8'));
    const events = await classifyPostings(account.id, postings, hiringLlm, DEMO_AS_OF, 'fixture');
    hiringEvents.push(...events);
  }

  const candidates: CandidateArticle[] = [];
  for (const account of coreAccounts) {
    const feedPath = `${DEMO_FEEDS_DIR}/${account.id}.json`;
    const items: FeedItem[] = JSON.parse(readFileSync(feedPath, 'utf-8'));
    candidates.push(...items.map((item) => ({ ...item, ownAccountId: account.id })));
  }
  const sweepItems: FeedItem[] = JSON.parse(readFileSync(DEMO_SWEEP_PATH, 'utf-8'));
  candidates.push(...sweepItems);

  const pressLlm = fixtureLlm(DEMO_PRESS_MATCH_PATH);
  const { events: pressEvents, reviewQueue } = await matchArticles(
    candidates,
    coreAccounts,
    pressLlm,
    DEMO_AS_OF,
    'fixture',
  );

  const events = [...hiringEvents, ...pressEvents];

  const playbook = loadPlaybook(DEFAULT_PLAYBOOK_PATH);
  const scored = scoreAccounts(accounts, events, playbook, DEMO_AS_OF);
  const scoreOutput = renderScoreTable(scored, accounts, events);

  let output = `${auditOutput}\n\n${scoreOutput}`;
  if (reviewQueue.length > 0) {
    output += `\n\n${renderReviewQueueSummary(reviewQueue)}`;
  }
  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reconciles the on-disk review queue with THIS run's items: overwrites the
 * file (one ReviewItem JSON per line) when the queue is non-empty, and
 * removes any stale file left by a previous run when it is empty — the file
 * on disk always reflects the latest run, never an older one.
 */
export function writeReviewQueue(path: string, items: ReviewItem[]): void {
  if (items.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, items.map((item) => JSON.stringify(item)).join('\n') + '\n');
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
 * hand the postings back for reuse by the classification step. Also keeps
 * each account's resolved RSS/Atom feed URL (when resolvable) for reuse by
 * the press/funding matching step, for the same reason: resolveRss was
 * already called here for the audit row, so re-resolving it later would
 * probe every domain a second time.
 */
async function auditAndFetchLive(
  accounts: Account[],
  delayMs = POLITENESS_DELAY_MS,
): Promise<{
  rows: AuditRow[];
  postingsByAccountId: Map<string, Posting[]>;
  feedUrlByAccountId: Map<string, string>;
}> {
  const rows: AuditRow[] = [];
  const postingsByAccountId = new Map<string, Posting[]>();
  const feedUrlByAccountId = new Map<string, string>();

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
    } else if (rssResult.feedUrl) {
      feedUrlByAccountId.set(account.id, rssResult.feedUrl);
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

  return { rows, postingsByAccountId, feedUrlByAccountId };
}

/**
 * Live scoring pipeline: real accounts, live ATS + RSS fetches, live Haiku
 * classification and entity matching. asOf is resolved to today here at the
 * CLI layer — scoreAccounts itself stays pure and never calls Date.now().
 *
 * Requires ANTHROPIC_API_KEY; throws (before any network call) if it is
 * unset so callers fail closed rather than burning a live ATS fetch first.
 *
 * Classifying every posting and matching every article costs one live Haiku
 * call each, so postings are capped to `maxPostings` (default
 * DEFAULT_MAX_POSTINGS_PER_ACCOUNT) most recent per account and articles to
 * `maxArticles` (default DEFAULT_MAX_ARTICLES_PER_FEED) most recent per feed,
 * both BEFORE any LLM spend — the two preflight lines print together, right
 * after fetching (which costs no LLM calls) and before either classification
 * loop starts.
 *
 * Writes `signal-events.jsonl` every run (every SignalEvent produced, one per
 * line, overwritten — Task 7's lift reads it) and reconciles
 * `review-queue.jsonl` every run: overwritten when the press/funding review
 * queue is non-empty, removed when it is empty (never stale).
 */
export async function runScoreLive(opts: {
  accounts: string;
  playbook: string;
  maxPostings?: number;
  maxArticles?: number;
  classifyModel?: string;
}): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set; live scoring requires it to classify hiring postings.',
    );
  }

  const accounts = loadAccounts(opts.accounts);
  const coreAccounts = accounts.filter((a) => a.group === 'core');
  const maxPostings = opts.maxPostings ?? DEFAULT_MAX_POSTINGS_PER_ACCOUNT;
  const maxArticles = opts.maxArticles ?? DEFAULT_MAX_ARTICLES_PER_FEED;
  const classifyModel = opts.classifyModel ?? CLASSIFY_MODEL;

  const { rows: auditRows, postingsByAccountId, feedUrlByAccountId } = await auditAndFetchLive(accounts);
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

  // Fetch press/funding candidates now (network, not LLM spend) so the
  // entity-match preflight line below reports an accurate count: each core
  // account's own resolved feed first, then the general sweep feeds — same
  // politeness delay as the audit pass, sequential, one feed at a time.
  const generalFeedUrls: string[] = existsSync(GENERAL_FEEDS_PATH)
    ? JSON.parse(readFileSync(GENERAL_FEEDS_PATH, 'utf-8'))
    : [];
  const feedSources: { url: string; ownAccountId?: string }[] = [
    ...coreAccounts
      .filter((a) => feedUrlByAccountId.has(a.id))
      .map((a) => ({ url: feedUrlByAccountId.get(a.id)!, ownAccountId: a.id })),
    ...generalFeedUrls.map((url) => ({ url })),
  ];
  const candidates: CandidateArticle[] = [];
  for (let i = 0; i < feedSources.length; i++) {
    const { url, ownAccountId } = feedSources[i];
    const items = await fetchFeedItems(url);
    const capped = items.slice(0, maxArticles);
    candidates.push(...capped.map((item) => (ownAccountId ? { ...item, ownAccountId } : item)));
    if (i < feedSources.length - 1) {
      await sleep(POLITENESS_DELAY_MS);
    }
  }

  console.log(
    `about to classify ${totalToClassify} postings across ${accountsToClassify} accounts (1 LLM call each)`,
  );
  if (totalSkipped > 0) {
    console.log(
      `skipped ${totalSkipped} posting(s) beyond the ${maxPostings}-per-account cap (override with --max-postings)`,
    );
  }
  console.log(`about to entity-match ${candidates.length} articles (1 LLM call each)`);

  const asOf = new Date().toISOString().slice(0, 10);
  const llm = liveLlm(classifyModel);

  const hiringEvents: SignalEvent[] = [];
  for (const account of accounts) {
    const postings = cappedByAccountId.get(account.id);
    if (!postings || postings.length === 0 || !account.ats) continue;
    const classified = await classifyPostings(account.id, postings, llm, asOf, account.ats.provider);
    hiringEvents.push(...classified);
  }

  const { events: pressEvents, reviewQueue } = await matchArticles(candidates, coreAccounts, llm, asOf, 'rss');

  const events = [...hiringEvents, ...pressEvents];

  writeFileSync(
    SIGNAL_EVENTS_PATH,
    events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : ''),
  );

  const playbook = loadPlaybook(opts.playbook);
  const scored = scoreAccounts(accounts, events, playbook, asOf);
  const scoreOutput = renderScoreTable(scored, accounts, events);

  // Always reconcile: write when non-empty, remove a stale file when empty —
  // otherwise a clean run would leave the previous run's queue on disk.
  writeReviewQueue(REVIEW_QUEUE_PATH, reviewQueue);

  let output = `${auditOutput}\n\n${scoreOutput}`;
  if (reviewQueue.length > 0) {
    output += `\n\n${renderReviewQueueSummary(reviewQueue)}`;
  }
  return output;
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
  .option(
    '--max-articles <n>',
    `cap articles entity-matched per feed, most recent first (live mode only)`,
    (value: string) => Number(value),
    DEFAULT_MAX_ARTICLES_PER_FEED,
  )
  .option(
    '--classify-model <model>',
    'model id used for hiring-posting classification and press/funding entity matching (live mode only)',
    CLASSIFY_MODEL,
  )
  .action(
    async (opts: {
      accounts: string;
      playbook: string;
      demo?: boolean;
      maxPostings: number;
      maxArticles: number;
      classifyModel: string;
    }) => {
      if (opts.demo) {
        if (opts.accounts !== DEFAULT_ACCOUNTS_PATH) {
          console.warn('--accounts is ignored when --demo is set');
        }
        if (opts.playbook !== DEFAULT_PLAYBOOK_PATH) {
          console.warn('--playbook is ignored when --demo is set');
        }
        if (opts.classifyModel !== CLASSIFY_MODEL) {
          console.warn('--classify-model is ignored when --demo is set');
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
