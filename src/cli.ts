import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import type { Account, AtsProvider } from './types.js';
import { probeBoard, type ProbeResult } from './sources/ats.js';
import { resolveRss, type RssResult } from './sources/rss.js';
import { auditAccounts, type AuditDeps } from './audit.js';
import { renderAuditTable } from './output/table.js';

const DEFAULT_ACCOUNTS_PATH = 'accounts/ai-startups.json';
const DEMO_ACCOUNTS_PATH = 'fixtures/demo/accounts.json';

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
  .description('Score accounts against a playbook (not implemented yet).')
  .action(() => {
    console.log('score: not implemented yet (Task 8)');
    process.exitCode = 1;
  });

// Only run the CLI when this file is the process entry point — importing it
// for its exports (tests) must not trigger argv parsing as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parseAsync(process.argv);
}
