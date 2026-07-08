import type { Account, FeedItem, PressMatch, ReviewItem, SignalEvent } from '../types.js';
import type { LlmClient } from '../llm.js';

/** A feed item queued for matching. `ownAccountId` is set when the item came
 * from an account's own resolved feed (own-feed matching skips the open-set
 * account search and forces that account's id). */
export interface CandidateArticle extends FeedItem {
  ownAccountId?: string;
}

const CATEGORIES = ['funding', 'product', 'hiring', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

const CONFIDENCE_THRESHOLD = 0.6;

/** Last path segment of a URL, with every non-alphanumeric character mapped
 * to '-'. Used both for event ids and for LLM call ids — this exact scheme
 * is binding (the demo fixture file is keyed by it). */
export function urlSlug(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(/[^a-zA-Z0-9]/g, '-');
}

function buildAccountsList(accounts: Account[]): string {
  return accounts.map((a) => `${a.id} | ${a.name} | ${a.domain}`).join('\n');
}

function buildSweepPrompt(item: CandidateArticle, accounts: Account[]): string {
  const companies = buildAccountsList(accounts);
  return (
    `You match news articles to a fixed list of companies. Companies:\n${companies}\n` +
    `Article title: "${item.title}" Summary: "${item.summary ?? ''}" URL: ${item.url}\n` +
    `Reply with ONLY strict JSON: {"accountId": <id from the list or null>, "confidence": <0..1>, ` +
    `"category": "funding"|"product"|"hiring"|"other", "amount": <string or null>, "date": <"yyyy-mm-dd" or null>}. ` +
    `accountId must be null unless the article is substantively about that company.`
  );
}

function buildOwnFeedPrompt(item: CandidateArticle, account: Account): string {
  return (
    `This article is from ${account.name}'s own blog/newsroom. ` +
    `Article title: "${item.title}" Summary: "${item.summary ?? ''}" URL: ${item.url}\n` +
    `Reply with ONLY strict JSON: {"accountId": "${account.id}", "confidence": <0..1>, ` +
    `"category": "funding"|"product"|"hiring"|"other", "amount": <string or null>, "date": <"yyyy-mm-dd" or null>}. ` +
    `Classify the article's category and extract the amount and date only if the article states them.`
  );
}

/** Strips one layer of a ```json ... ``` (or bare ``` ... ```) fence, if
 * present, then JSON.parses the result and strictly validates the full
 * PressMatch shape: accountId string|null (present), confidence a number in
 * [0,1], category one of the four labels, amount string|null, date
 * string|null. Returns undefined on any violation — malformed fields are
 * never coerced (a numeric accountId must warn as invalid, not silently
 * become a null match and get dropped as sweep noise). */
function parseMatch(raw: string): PressMatch | undefined {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unwrapped = fenceMatch ? fenceMatch[1].trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  const { accountId, confidence, category, amount, date } = obj;
  if (!('accountId' in obj) || (accountId !== null && typeof accountId !== 'string')) {
    return undefined;
  }
  if (
    typeof confidence !== 'number' ||
    Number.isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return undefined;
  }
  if (!isCategory(category)) return undefined;
  if (amount !== null && typeof amount !== 'string') return undefined;
  if (date !== null && typeof date !== 'string') return undefined;

  return { accountId, confidence, category, amount, date };
}

/** Resolves an event date: prefer an explicit extracted/item date; fall back
 * to asOf with dateEstimated:true when neither is available. */
function resolveDate(
  preferred: string | null | undefined,
  itemDate: string | undefined,
  asOf: string,
): { date: string; dateEstimated?: boolean } {
  const date = preferred || itemDate;
  if (date) return { date };
  return { date: asOf, dateEstimated: true };
}

/**
 * Matches each candidate article to a tracked account and classifies it with
 * one sequential LlmClient.generate call per article (ADR 0001: single-call
 * entity matching, no embeddings). Confident matches (>= 0.6) become
 * SignalEvents; low-confidence matches are routed to a review queue instead
 * of being silently accepted. Own-feed candidates skip open-set matching:
 * the account id is forced and confidence is floored at 0.9.
 */
export async function matchArticles(
  candidates: CandidateArticle[],
  accounts: Account[],
  llm: LlmClient,
  asOf: string,
  source: string,
): Promise<{ events: SignalEvent[]; reviewQueue: ReviewItem[] }> {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const events: SignalEvent[] = [];
  const reviewQueue: ReviewItem[] = [];
  const seenEventKeys = new Set<string>();

  for (const item of candidates) {
    const isOwnFeed = item.ownAccountId !== undefined;
    const ownAccount = isOwnFeed ? accountsById.get(item.ownAccountId!) : undefined;
    if (isOwnFeed && !ownAccount) {
      // An own-feed owner outside the provided accounts list must never emit
      // an event for an account outside the allowed set — skip before any
      // LLM call is made.
      console.warn(
        `matchArticles: own-feed accountId "${item.ownAccountId}" is not in the accounts list for "${item.url}"; skipping`,
      );
      continue;
    }

    const prompt = ownAccount
      ? buildOwnFeedPrompt(item, ownAccount)
      : buildSweepPrompt(item, accounts);

    const raw = await llm.generate({
      id: `press-match:${item.ownAccountId ?? 'sweep'}:${urlSlug(item.url)}`,
      prompt,
      maxTokens: 300,
    });

    const match = parseMatch(raw);
    if (!match) {
      console.warn(`matchArticles: could not parse LLM response for "${item.url}": ${raw}`);
      continue;
    }

    let accountId: string;
    let confidence: number;
    if (isOwnFeed) {
      // Own-feed matching skips open-set entity matching entirely — the
      // model's accountId (if any) is irrelevant, we already know it.
      accountId = item.ownAccountId!;
      confidence = Math.max(match.confidence, 0.9);
    } else {
      if (match.accountId === null) {
        // Sweep noise is expected and not an error — skip silently.
        continue;
      }
      if (!accountsById.has(match.accountId)) {
        console.warn(
          `matchArticles: unknown accountId "${match.accountId}" for "${item.url}"; skipping`,
        );
        continue;
      }
      accountId = match.accountId;
      confidence = match.confidence;
    }

    if (confidence < CONFIDENCE_THRESHOLD) {
      reviewQueue.push({
        url: item.url,
        title: item.title,
        accountId,
        confidence,
        reason: `low-confidence match (${confidence} < ${CONFIDENCE_THRESHOLD})`,
      });
      continue;
    }

    const dedupeKey = `${accountId}::${item.url}`;
    if (seenEventKeys.has(dedupeKey)) {
      continue;
    }

    let event: SignalEvent;
    if (match.category === 'funding') {
      const { date, dateEstimated } = resolveDate(match.date, item.date, asOf);
      const summary = match.amount ? `${item.title} — ${match.amount}` : item.title;
      event = {
        id: `funding:${accountId}:${urlSlug(item.url)}`,
        accountId,
        type: 'funding',
        subtype: 'round',
        date,
        url: item.url,
        summary,
        confidence,
        source,
        demo: source === 'fixture',
        ...(dateEstimated ? { dateEstimated: true } : {}),
      };
    } else {
      const { date, dateEstimated } = resolveDate(undefined, item.date, asOf);
      event = {
        id: `press:${accountId}:${urlSlug(item.url)}`,
        accountId,
        type: 'press',
        subtype: 'article',
        date,
        url: item.url,
        summary: item.title,
        confidence,
        source,
        demo: source === 'fixture',
        ...(dateEstimated ? { dateEstimated: true } : {}),
      };
    }

    seenEventKeys.add(dedupeKey);
    events.push(event);
  }

  return { events, reviewQueue };
}
