import type { Account, AuditRow, ReviewItem, ScoredAccount, SignalEvent } from '../types.js';

const GROUPS: Array<AuditRow['group']> = ['core', 'contrast'];
const GROUP_LABEL_WIDTH = 8;

function percent(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

function summaryLine(group: AuditRow['group'], rows: AuditRow[]): string {
  const total = rows.length;
  const atsCount = rows.filter((r) => r.atsReachable === true).length;
  const rssCount = rows.filter((r) => r.rssResolvable).length;
  return (
    `${group.padEnd(GROUP_LABEL_WIDTH)} ATS ${atsCount}/${total} (${percent(atsCount, total)}) · ` +
    `RSS ${rssCount}/${total} (${percent(rssCount, total)})`
  );
}

function atsCell(row: AuditRow): string {
  if (row.atsReachable === true) {
    return `${row.atsProvider ?? '?'} (${row.postingCount ?? 0})`;
  }
  return '—';
}

function rssCell(row: AuditRow): string {
  return row.rssResolvable ? '✓' : '—';
}

/**
 * Renders the coverage audit as a plain string: per-group summary lines
 * (ATS %/RSS %, with atsReachable:null counted in the denominator — "no
 * board found" is itself a finding), then one aligned row per account, then
 * a demo-data warning footer if any account was a demo fixture.
 */
export function renderAuditTable(rows: AuditRow[]): string {
  const lines: string[] = [];

  for (const group of GROUPS) {
    const groupRows = rows.filter((r) => r.group === group);
    if (groupRows.length === 0) continue;
    lines.push(summaryLine(group, groupRows));
  }

  lines.push('');

  const idWidth = Math.max(0, ...rows.map((r) => r.accountId.length));
  const atsWidth = Math.max(0, ...rows.map((r) => atsCell(r).length));

  for (const row of rows) {
    const notes = row.notes.join('; ');
    lines.push(
      `${row.accountId.padEnd(idWidth)}  ${row.group.padEnd(GROUP_LABEL_WIDTH)}  ` +
        `ats ${atsCell(row).padEnd(atsWidth)}  rss ${rssCell(row)}  ${notes}`.trimEnd(),
    );
  }

  if (rows.some((r) => r.demo)) {
    lines.push('');
    lines.push('⚠ synthetic demo data — fictional companies');
  }

  return lines.join('\n');
}

const MAX_CONTRIBUTIONS_SHOWN = 3;

/**
 * Renders a ranked score table: one summary line per account (rank, name,
 * score to 2dp) followed by up to 3 indented top-contribution lines (points,
 * decay factor, subtype, date, url — full lineage back to the source event)
 * and any applied compound multipliers, then a demo-data warning footer if
 * any scored account was a demo fixture.
 */
export function renderScoreTable(
  scored: ScoredAccount[],
  accounts: Account[],
  events: SignalEvent[],
): string {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const eventById = new Map(events.map((e) => [e.id, e]));

  const nameWidth = Math.max(
    0,
    ...scored.map((s) => (accountById.get(s.accountId)?.name ?? s.accountId).length),
  );

  const lines: string[] = [];

  scored.forEach((s, index) => {
    const account = accountById.get(s.accountId);
    const name = account?.name ?? s.accountId;
    const rank = index + 1;
    lines.push(`${rank}  ${name.padEnd(nameWidth)}  ${s.score.toFixed(2)}`);

    const topContributions = [...s.contributions]
      .sort((a, b) => b.points - a.points)
      .slice(0, MAX_CONTRIBUTIONS_SHOWN);

    for (const c of topContributions) {
      const event = eventById.get(c.eventId);
      const subtype = event?.subtype ?? '?';
      lines.push(
        `    ${c.points.toFixed(2)} (decay×${c.decayFactor.toFixed(2)}) ${subtype} ${c.eventDate} ${c.eventUrl}`,
      );
    }

    for (const compound of s.compoundsApplied) {
      lines.push(`    compound ×${compound.multiplier}: ${compound.compoundId}`);
    }
  });

  if (scored.some((s) => accountById.get(s.accountId)?.demo)) {
    lines.push('');
    lines.push('⚠ synthetic demo data — fictional companies');
  }

  return lines.join('\n');
}

/**
 * Renders the low-confidence press-match review queue: a fixed header
 * followed by one line per item, in input order — `? title — accountId
 * (confidence) reason`. Never silently matched (ADR 0001): this is the
 * human-facing surface for everything matchArticles routed here instead of
 * emitting an event.
 */
export function renderReviewQueueSummary(items: ReviewItem[]): string {
  const lines = ['review queue (needs a human):'];
  for (const item of items) {
    lines.push(`? ${item.title} — ${item.accountId} (${item.confidence}) ${item.reason}`);
  }
  return lines.join('\n');
}
