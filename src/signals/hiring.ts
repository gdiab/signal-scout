import type { HiringLabel, Posting, SignalEvent } from '../types.js';
import type { LlmClient } from '../llm.js';

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

/**
 * Builds the classification prompt from the playbook's label ontology. Labels
 * without descriptions produce the bare-id list format; any label with a
 * description adds a Definitions clause between the label list and the
 * reply instruction.
 */
export function buildPrompt(posting: Posting, labels: HiringLabel[]): string {
  const location = posting.location ? ` Location: ${posting.location}.` : '';
  const ids = labels.map((l) => l.id).join(', ');
  const described = labels.filter((l) => l.description !== undefined);
  const definitions =
    described.length > 0
      ? `Definitions: ${described.map((l) => `${l.id} = ${l.description}`).join('; ')}. `
      : '';
  return (
    `Job posting title: "${posting.title}".${location} ` +
    `Classify this job posting into exactly one of: ${ids}, other. ` +
    definitions +
    `Reply with EXACTLY one label from that list and no other text.`
  );
}

/**
 * Classifies each Posting with one sequential LLM call per posting, turning
 * recognized labels (other than 'other') into hiring SignalEvents. The label
 * vocabulary, and any account-level reclassification rules, come entirely
 * from the playbook's hiringLabels — this module knows no ontology of its own.
 */
export async function classifyPostings(
  accountId: string,
  postings: Posting[],
  llm: LlmClient,
  asOf: string,
  source: string,
  labels: HiringLabel[],
): Promise<SignalEvent[]> {
  const labelIds = new Set(labels.map((l) => l.id));
  const events: SignalEvent[] = [];

  for (const posting of postings) {
    const raw = await llm.classify({
      id: `${accountId}:${posting.id}`,
      prompt: buildPrompt(posting, labels),
    });
    const normalized = normalizeResponse(raw);
    let label: string;
    if (labelIds.has(normalized) || normalized === 'other') {
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
      ...(posting.publishedAt ? {} : { dateEstimated: true }),
    });
  }

  // A per-posting classifier can't see the account's overall hiring state —
  // e.g. it labels every open GTM role 'first-gtm' even at a company with a
  // full GTM org. Playbooks express the account-level correction as a
  // reclassifyAtCount rule: when an account accumulates >= threshold events
  // of a label, all of them are demoted to the rule's derived subtype.
  for (const label of labels) {
    const rule = label.reclassifyAtCount;
    if (!rule) continue;
    const count = events.filter((e) => e.subtype === label.id).length;
    if (count >= rule.threshold) {
      for (const event of events) {
        if (event.subtype === label.id) {
          event.subtype = rule.to;
        }
      }
    }
  }

  return events;
}
