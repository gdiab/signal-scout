import type { Account, AuditRow, Brief, LiftRow, Playbook, ScoredAccount, SignalEvent } from '../types.js';

/** Everything the report needs to render, already computed by the caller —
 * this module never fetches, scores, or calls an LLM, and never calls
 * Date.now() (generatedAt is injected). */
export interface ReportData {
  generatedAt: string; // ISO date — injected, never Date.now() inside the renderer
  demo: boolean;
  auditRows: AuditRow[];
  scored: ScoredAccount[];
  accounts: Account[];
  events: SignalEvent[];
  briefs: Brief[];
  lift?: LiftRow[];
  playbook: Playbook;
}

const GROUPS: Array<AuditRow['group']> = ['core', 'contrast'];
const MAX_CONTRIBUTIONS_SHOWN = 3;
const DEMO_BANNER = '⚠ synthetic demo data — fictional companies';

/**
 * The one HTML-escaper every dynamic string flows through before being
 * written into the page — including URLs used in `href` attributes, which
 * are attribute context, not just text context. Escapes the five characters
 * that matter for both: `& < > " '`.
 */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function percent(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

function renderBanner(): string {
  return `<p class="banner">${esc(DEMO_BANNER)}</p>`;
}

/** Matches only the two schemes safe to render as a clickable link. Anything
 * else (javascript:, data:, etc.) is rendered as escaped plain text instead —
 * event/contribution URLs come from LLM-extracted or ATS-provided data, never
 * validated as http(s) upstream, so this is the last line of defense against
 * an href that executes script when clicked. */
const SAFE_URL_SCHEME = /^https?:\/\//i;

/** Renders a citation URL as a clickable `<a href>` only when it matches
 * `SAFE_URL_SCHEME`; otherwise renders it as escaped plain text. */
function renderUrlLink(url: string): string {
  if (!SAFE_URL_SCHEME.test(url)) {
    return esc(url);
  }
  return `<a href="${esc(url)}">${esc(url)}</a>`;
}

/** Per-group ATS/RSS coverage percentages plus one row per account — the HTML
 * sibling of renderAuditTable in output/table.ts, same source data. */
function renderAuditSection(rows: AuditRow[]): string {
  const summaryItems = GROUPS.map((group) => {
    const groupRows = rows.filter((r) => r.group === group);
    if (groupRows.length === 0) return '';
    const total = groupRows.length;
    const atsCount = groupRows.filter((r) => r.atsReachable === true).length;
    const rssCount = groupRows.filter((r) => r.rssResolvable).length;
    return (
      `<li><strong>${esc(group)}</strong> — ATS ${atsCount}/${total} (${percent(atsCount, total)}) ` +
      `&middot; RSS ${rssCount}/${total} (${percent(rssCount, total)})</li>`
    );
  })
    .filter(Boolean)
    .join('\n');

  const bodyRows = rows
    .map((row) => {
      const ats = row.atsReachable === true ? `${esc(row.atsProvider ?? '?')} (${row.postingCount ?? 0})` : '—';
      const rss = row.rssResolvable ? '✓' : '—';
      const notes = esc(row.notes.join('; '));
      return (
        `<tr><td>${esc(row.accountId)}</td><td>${esc(row.group)}</td>` +
        `<td>${ats}</td><td>${rss}</td><td>${notes}</td></tr>`
      );
    })
    .join('\n');

  return `
  <section>
    <h2>Coverage audit</h2>
    <ul class="summary">
      ${summaryItems}
    </ul>
    <table>
      <thead><tr><th>Account</th><th>Group</th><th>ATS</th><th>RSS</th><th>Notes</th></tr></thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  </section>`;
}

/** Ranked scores: rank, name, score, an always-visible (no JS, no
 * expand/collapse) flat list of the top-3 contributions with dates and
 * clickable cited links, plus any compounds applied. */
function renderScoresSection(scored: ScoredAccount[], accounts: Account[], events: SignalEvent[]): string {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const eventById = new Map(events.map((e) => [e.id, e]));

  const rows = scored
    .map((s, index) => {
      const account = accountById.get(s.accountId);
      const name = account?.name ?? s.accountId;
      const rank = index + 1;

      const topContributions = [...s.contributions]
        .sort((a, b) => b.points - a.points)
        .slice(0, MAX_CONTRIBUTIONS_SHOWN);

      const contributionItems = topContributions
        .map((c) => {
          const event = eventById.get(c.eventId);
          const subtype = event?.subtype ?? '?';
          return (
            `<li>${c.points.toFixed(2)} pts (decay&times;${c.decayFactor.toFixed(2)}) ${esc(subtype)} — ` +
            `${esc(c.eventDate)} — ${renderUrlLink(c.eventUrl)}</li>`
          );
        })
        .join('\n');

      const compoundItems = s.compoundsApplied
        .map((c) => `<li class="compound">compound &times;${esc(String(c.multiplier))}: ${esc(c.compoundId)}</li>`)
        .join('\n');

      return `
      <li class="score-row">
        <div class="score-head">
          <span class="rank">${rank}</span>
          <span class="name">${esc(name)}</span>
          <span class="score">${s.score.toFixed(2)}</span>
        </div>
        <ul class="contributions">
          ${contributionItems}
          ${compoundItems}
        </ul>
      </li>`;
    })
    .join('\n');

  return `
  <section>
    <h2>Ranked scores</h2>
    <ol class="scores">
      ${rows}
    </ol>
  </section>`;
}

/** One <section> per brief; \n in the brief text becomes <br>, and citations
 * are left as plain visible URLs (the brief text itself, not re-linked). */
function renderBriefsSection(briefs: Brief[], accounts: Account[]): string {
  if (briefs.length === 0) return '';
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const sections = briefs
    .map((brief) => {
      const account = accountById.get(brief.accountId);
      const name = account?.name ?? brief.accountId;
      const body = esc(brief.text).replace(/\n/g, '<br>');
      const warn =
        brief.uncitedUrls.length > 0 || brief.citedUrls.length === 0
          ? '<p class="warn">&#9888; uncited claims</p>'
          : '';
      return `
      <section class="brief">
        <h3>${esc(name)}</h3>
        <p>${body}</p>
        ${warn}
      </section>`;
    })
    .join('\n');

  return `
  <section>
    <h2>Why-now briefs</h2>
    ${sections}
  </section>`;
}

/** Omitted entirely when `rows` is undefined (no outcome log to compare
 * against) — never rendered as an all-n/a table. */
function renderLiftSection(rows: LiftRow[] | undefined, playbook: Playbook): string {
  if (!rows) return '';
  const weightById = new Map(playbook.weights.map((w) => [w.id, w]));

  const bodyRows = rows
    .map((row) => {
      const currentStatus = weightById.get(row.weightId)?.status ?? '?';
      const withPct = row.withRate === null ? 'n/a' : `${Math.round(row.withRate * 100)}%`;
      const withoutPct = row.withoutRate === null ? 'n/a' : `${Math.round(row.withoutRate * 100)}%`;
      const caveats = row.caveats.map((c) => `<div class="caveat">&#9888; ${esc(c)}</div>`).join('');
      return (
        `<tr><td>${esc(row.weightId)}</td><td>${esc(currentStatus)}</td>` +
        `<td>${row.withSucceeded}/${row.withAttempted} (${withPct})</td>` +
        `<td>${row.withoutSucceeded}/${row.withoutAttempted} (${withoutPct})</td>` +
        `<td class="suggestion">${esc(row.suggestion)}${caveats}</td></tr>`
      );
    })
    .join('\n');

  return `
  <section>
    <h2>Experiment loop — lift</h2>
    <table>
      <thead><tr><th>Weight</th><th>Status</th><th>With</th><th>Without</th><th>Suggestion</th></tr></thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
    <p class="note">Suggestions are proposals for the playbook's weight <code>status</code> fields — review and apply by hand.</p>
  </section>`;
}

function renderFooter(data: ReportData): string {
  const banner = data.demo ? renderBanner() : '';
  return `
  <footer>
    ${banner}
    <p>Generated ${esc(data.generatedAt)} &middot; playbook: ${esc(data.playbook.name)}</p>
  </footer>`;
}

const STYLE = `
    :root { color-scheme: light dark; --accent: #3b6ea5; --border: #d8d8d8; --bg: #ffffff; --fg: #1a1a1a; --muted: #666666; }
    @media (prefers-color-scheme: dark) {
      :root { --border: #3a3a3a; --bg: #16181c; --fg: #e8e8e8; --muted: #9a9a9a; }
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      margin: 0;
      padding: 0 1.25rem 3rem;
      line-height: 1.5;
    }
    header, main, footer { max-width: 860px; margin: 0 auto; }
    header { padding-top: 2rem; }
    h1 { margin-bottom: 0.25rem; }
    .tagline { color: var(--muted); margin-top: 0; }
    h2 { border-bottom: 2px solid var(--accent); padding-bottom: 0.25rem; margin-top: 2.5rem; }
    section > section.brief { margin-top: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    ul.summary { list-style: none; padding: 0; }
    ol.scores { list-style: none; padding: 0; counter-reset: none; }
    li.score-row { border-bottom: 1px solid var(--border); padding: 0.75rem 0; }
    .score-head { display: flex; align-items: baseline; gap: 0.6rem; }
    .score-head .rank { color: var(--muted); font-variant-numeric: tabular-nums; }
    .score-head .name { font-weight: 600; flex: 1; }
    .score-head .score { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }
    ul.contributions { margin: 0.35rem 0 0; padding-left: 1.5rem; color: var(--muted); font-size: 0.92rem; }
    ul.contributions li.compound { color: var(--accent); }
    a { color: var(--accent); }
    .brief h3 { margin-bottom: 0.25rem; }
    .warn, .caveat { color: #b45309; font-size: 0.9rem; }
    .banner { background: #fff4e5; color: #7a4a00; border: 1px solid #e8b768; border-radius: 6px; padding: 0.6rem 0.9rem; font-weight: 600; }
    @media (prefers-color-scheme: dark) {
      .banner { background: #3a2c10; color: #f0c780; border-color: #6b4e12; }
    }
    .note { color: var(--muted); font-size: 0.9rem; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; }
`;

/**
 * Renders one self-contained HTML report string: inline `<style>` only, no
 * external assets, no `<script>` — safe to open from a fresh clone with no
 * server. Every dynamic string is escaped via `esc()`, including URLs used
 * as `href` attribute values.
 */
export function renderHtmlReport(data: ReportData): string {
  const topBanner = data.demo ? renderBanner() : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>signal-scout report</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h1>signal-scout</h1>
    <p class="tagline">Growth-signal report — ranked accounts, cited evidence, an experiment loop.</p>
    ${topBanner}
  </header>
  <main>
    ${renderAuditSection(data.auditRows)}
    ${renderScoresSection(data.scored, data.accounts, data.events)}
    ${renderBriefsSection(data.briefs, data.accounts)}
    ${renderLiftSection(data.lift, data.playbook)}
  </main>
  ${renderFooter(data)}
</body>
</html>
`;
}
