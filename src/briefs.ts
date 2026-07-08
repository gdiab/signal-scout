import type { Account, Brief, ScoredAccount, SignalEvent } from './types.js';
import type { LlmClient } from './llm.js';

/** The exact instruction text appended to every brief prompt (binding: quoted
 * verbatim in the task brief). */
const BRIEF_INSTRUCTION =
  'Write a short outreach brief with exactly three labeled sections: SIGNALS, WHY NOW, SUGGESTED ANGLE. ' +
  'Every factual claim must end with a citation in the form (URL, yyyy-mm-dd) using ONLY the URLs provided above. ' +
  'Do not invent facts, numbers, or names not present in the events. Plain text, no markdown headers.';

const MAX_TOKENS = 700;

/** Matches http(s) URLs, stopping before a comma or closing paren so the
 * `(URL, yyyy-mm-dd)` citation form doesn't swallow the trailing punctuation
 * into the URL itself. */
const URL_REGEX = /https?:\/\/[^\s,)]+/g;

function buildPrompt(accountName: string, events: SignalEvent[], asOf: string): string {
  const bullets = events
    .map((e) => `- ${e.date} [${e.type}/${e.subtype}] ${e.summary} (${e.url})`)
    .join('\n');
  return (
    `As of ${asOf}, account: ${accountName}\n` +
    `Contributing signal events:\n${bullets}\n\n` +
    BRIEF_INSTRUCTION
  );
}

/**
 * Writes one outreach brief per qualifying scored account (top `topN` with
 * score > 0, in the order given — `scored` is assumed already ranked, same
 * convention as renderScoreTable) via one llm.generate call each (id
 * `brief:${accountId}`, binding — keys the fixture file). The prompt supplies
 * only the account's *contributing* events (mapped from
 * ScoredAccount.contributions back to the merged event set used for scoring)
 * as dated, URL-cited bullets, so the model has no other URLs to cite.
 *
 * Post-validation: every http(s) URL found in the response text is
 * partitioned into `citedUrls` (belongs to one of this account's contributing
 * events) or `uncitedUrls` (does not) — the model can still hallucinate a URL
 * despite the instruction, so this is enforced after the fact, never trusted.
 * Any uncited URL is logged via console.warn; a brief with citedUrls empty
 * (no citations at all) is not itself warned here — renderBriefs surfaces
 * that in the human-facing output instead.
 */
export async function writeBriefs(
  scored: ScoredAccount[],
  accounts: Account[],
  events: SignalEvent[],
  llm: LlmClient,
  topN: number,
  asOf: string,
): Promise<Brief[]> {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const eventById = new Map(events.map((e) => [e.id, e]));

  const qualifying = scored.filter((s) => s.score > 0).slice(0, topN);

  const briefs: Brief[] = [];
  for (const s of qualifying) {
    const account = accountById.get(s.accountId);
    const name = account?.name ?? s.accountId;

    const contributingEvents = s.contributions
      .map((c) => eventById.get(c.eventId))
      .filter((e): e is SignalEvent => e !== undefined);
    const eventUrls = new Set(contributingEvents.map((e) => e.url));

    const prompt = buildPrompt(name, contributingEvents, asOf);
    const text = await llm.generate({ id: `brief:${s.accountId}`, prompt, maxTokens: MAX_TOKENS });

    const foundUrls = text.match(URL_REGEX) ?? [];
    const citedUrls: string[] = [];
    const uncitedUrls: string[] = [];
    for (const url of foundUrls) {
      if (eventUrls.has(url)) {
        citedUrls.push(url);
      } else {
        uncitedUrls.push(url);
      }
    }

    for (const url of uncitedUrls) {
      console.warn(`writeBriefs: uncited URL "${url}" in brief for account "${s.accountId}"`);
    }

    briefs.push({ accountId: s.accountId, text, citedUrls, uncitedUrls });
  }

  return briefs;
}
