import type { Account, AuditRow } from './types.js';
import type { probeBoard } from './sources/ats.js';

export interface AuditDeps {
  probeBoard: typeof probeBoard;
  probeRss: (domain: string, rss?: string, fetchImpl?: typeof fetch) => Promise<{ resolvable: boolean; feedUrl?: string }>;
  fetchImpl?: typeof fetch;
  /** Delay between accounts in ms, for politeness against real ATS/RSS hosts. Default 150; pass 0 in tests. */
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Audits signal AVAILABILITY (not content) for every account, sequentially
 * (politeness — one account's ATS/RSS probes at a time, with a delay between
 * accounts). For accounts with no `ats` slug configured, atsReachable is
 * null (no probe attempted) rather than false — "no board found" is itself
 * the finding, distinct from "board found but unreachable".
 */
export async function auditAccounts(accounts: Account[], deps: AuditDeps): Promise<AuditRow[]> {
  const delayMs = deps.delayMs ?? 150;
  const rows: AuditRow[] = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const notes: string[] = [];

    let atsReachable: boolean | null = null;
    let atsProvider: AuditRow['atsProvider'];
    let postingCount: number | undefined;

    if (account.ats) {
      atsProvider = account.ats.provider;
      const result = await deps.probeBoard(account.ats.provider, account.ats.slug, deps.fetchImpl);
      atsReachable = result.reachable;
      if (result.reachable) {
        postingCount = result.postingCount;
      } else {
        notes.push(result.error ? `ats error: ${result.error}` : 'ats board unreachable');
      }
    } else {
      notes.push('no ats slug configured');
    }

    const rssResult = await deps.probeRss(account.domain, account.rss, deps.fetchImpl);
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

  return rows;
}
