export type AtsProvider = 'greenhouse' | 'lever' | 'ashby';

export interface Account {
  id: string;                 // kebab-case slug, unique
  name: string;
  domain: string;             // demo accounts MUST end .example
  group: 'core' | 'contrast';
  ats?: { provider: AtsProvider; slug: string };
  rss?: string;               // known feed URL if any
  demo?: boolean;             // true only in fixtures/demo/accounts.json
}

export type SignalType = 'hiring' | 'funding' | 'press';

export interface SignalEvent {
  id: string;
  accountId: string;
  type: SignalType;
  subtype: string;            // hiring: 'growth-eng' | 'first-gtm' | 'ai-eng' | 'generic-eng' | 'other'
  date: string;               // ISO yyyy-mm-dd
  url: string;                // citation — REQUIRED, every event traceable
  summary: string;
  confidence: number;         // 0..1
  source: string;             // e.g. 'greenhouse', 'fixture'
  demo: boolean;
  dateEstimated?: boolean;    // true when the source had no date and `date` was filled with asOf.
                              // Scoring applies a flat 0.5 decay and the event cannot activate compounds.
}

export interface Weight {
  id: string;
  signalType: SignalType;
  subtype?: string;           // matches SignalEvent.subtype when present
  points: number;
  maxEventsPerAccount?: number; // top-K contributing events per account for this weight; unlimited when absent
  hypothesis: string;
  status: 'untested' | 'supported' | 'refuted';
}

export interface Compound {
  id: string;
  requiresWeightIds: [string, string];
  withinDays: number;         // both events within this window of each other
  multiplier: number;
  hypothesis: string;
  status: 'untested' | 'supported' | 'refuted';
}

export interface HiringLabel {
  id: string;                 // classifier output label; 'other' is implicit and must not be declared
  description?: string;       // when present, appended to the classifier prompt as a definition
  reclassifyAtCount?: {       // account-level demotion: >= threshold events of this label
    threshold: number;        // are relabeled `to` (a derived subtype, never sent to the classifier)
    to: string;
  };
}

export interface Playbook {
  name: string;
  description: string;
  halfLifeDays: Record<SignalType, number>;
  hiringLabels: HiringLabel[];
  weights: Weight[];
  compounds: Compound[];
}

export interface Contribution {
  weightId: string;
  eventId: string;
  eventUrl: string;
  eventDate: string;
  basePoints: number;
  decayFactor: number;        // 0.5 ** (ageDays / halfLife)
  points: number;             // basePoints * decayFactor
}

export interface ScoredAccount {
  accountId: string;
  score: number;              // rounded to 2dp at output layer only
  contributions: Contribution[];
  compoundsApplied: { compoundId: string; multiplier: number }[];
}

export interface Posting {   // normalized across the 3 ATS providers
  id: string;
  title: string;
  url: string;
  publishedAt: string;       // ISO date; empty when the provider omits it (e.g. Ashby) —
                              // classifyPostings then falls back to asOf and flags dateEstimated
  location?: string;
}

export interface FeedItem {
  title: string;
  url: string;
  date?: string;               // ISO yyyy-mm-dd when the feed provided one
  summary?: string;
}

export interface PressMatch {
  accountId: string | null;   // matched account id, or null = none of our accounts
  confidence: number;         // 0..1
  category: 'funding' | 'product' | 'hiring' | 'other';
  amount: string | null;      // e.g. "$18M" when category=funding and stated
  date: string | null;        // ISO date extracted from the article text when stated
}

export interface ReviewItem {
  url: string;
  title: string;
  accountId: string | null;
  confidence: number;
  reason: string;             // e.g. 'low-confidence match (0.45 < 0.6)'
}

export interface Brief {
  accountId: string;
  text: string;               // plain text with (URL, yyyy-mm-dd) citations
  citedUrls: string[];        // URLs in text that belong to the account's events
  uncitedUrls: string[];      // URLs in text NOT in the account's events (should be empty; warned)
}

export interface OutcomeEvent {
  accountId: string;
  stage: string;              // 'scored' | 'contacted' | 'replied' | 'applied' | 'responded'
  date: string;               // ISO yyyy-mm-dd
  demo?: boolean;
}

export interface LiftRow {
  weightId: string;
  withAttempted: number;      // accounts having this weight's contribution AND ≥1 attempt-stage outcome
  withSucceeded: number;
  withoutAttempted: number;
  withoutSucceeded: number;
  withRate: number | null;    // withSucceeded/withAttempted; null when denominator 0
  withoutRate: number | null;
  suggestion: 'supported' | 'refuted' | 'inconclusive';
  caveats: string[];          // always includes an n-size note when either side < minN
}

export interface AuditRow {
  accountId: string;
  group: 'core' | 'contrast';
  atsReachable: boolean | null;   // null = no slug configured
  atsProvider?: AtsProvider;
  postingCount?: number;
  rssResolvable: boolean;
  notes: string[];
  demo?: boolean;              // true when the source account was a demo fixture
}
