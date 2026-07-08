import type { Posting, SignalEvent } from '../types.js';
import type { LlmClient } from '../llm.js';

const LABELS = ['growth-eng', 'first-gtm', 'ai-eng', 'generic-eng', 'other'] as const;
type HiringLabel = (typeof LABELS)[number];

function isHiringLabel(value: string): value is HiringLabel {
  return (LABELS as readonly string[]).includes(value);
}

/**
 * Normalizes a raw model response toward a bare label: trim + lowercase, then
 * strip one layer of wrapping quotes/backticks and one trailing period —
 * tolerating realistic near-miss outputs like `"growth-eng"` or `ai-eng.`
 * without accepting genuinely non-label prose.
 */
function normalizeResponse(raw: string): string {
  let value = raw.trim().toLowerCase();
  const wrapped = value.match(/^(["'`])(.*)\1$/s);
  if (wrapped) {
    value = wrapped[2].trim();
  }
  if (value.endsWith('.')) {
    value = value.slice(0, -1).trim();
  }
  return value;
}

function buildPrompt(posting: Posting): string {
  const location = posting.location ? ` Location: ${posting.location}.` : '';
  return (
    `Job posting title: "${posting.title}".${location} ` +
    `Classify this job posting into exactly one of: growth-eng, first-gtm, ai-eng, generic-eng, other. ` +
    `Reply with EXACTLY one label from that list and no other text.`
  );
}

/**
 * Classifies each Posting with one sequential LLM call per posting, turning
 * recognized labels (other than 'other') into hiring SignalEvents.
 */
export async function classifyPostings(
  accountId: string,
  postings: Posting[],
  llm: LlmClient,
  asOf: string,
  source: string,
): Promise<SignalEvent[]> {
  const events: SignalEvent[] = [];

  for (const posting of postings) {
    const raw = await llm.classify({
      id: `${accountId}:${posting.id}`,
      prompt: buildPrompt(posting),
    });
    const normalized = normalizeResponse(raw);
    let label: HiringLabel;
    if (isHiringLabel(normalized)) {
      label = normalized;
    } else {
      label = 'other';
      console.warn(
        `classifyPostings: unrecognized response "${raw}" for posting ${posting.id}; treating as 'other'`,
      );
    }

    if (label === 'other') {
      continue;
    }

    events.push({
      id: `hiring:${accountId}:${posting.id}`,
      accountId,
      type: 'hiring',
      subtype: label,
      date: posting.publishedAt || asOf,
      url: posting.url,
      summary: posting.title,
      confidence: 0.9,
      source,
      demo: source === 'fixture',
    });
  }

  // A per-posting classifier can't see the account's overall hiring state, so
  // it labels every open GTM role 'first-gtm' — a company with a full GTM org
  // (many open GTM roles) would otherwise score as if each one were the
  // first hire, the opposite of the "first GTM hire" hypothesis. Demote at
  // the account level, after the loop: 3+ first-gtm postings means the motion
  // is already staffed, so relabel all of them 'gtm-expansion'.
  const firstGtmCount = events.filter((e) => e.subtype === 'first-gtm').length;
  if (firstGtmCount > 2) {
    for (const event of events) {
      if (event.subtype === 'first-gtm') {
        event.subtype = 'gtm-expansion';
      }
    }
  }

  return events;
}
