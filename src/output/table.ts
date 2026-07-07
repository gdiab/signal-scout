import type { AuditRow } from '../types.js';

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
