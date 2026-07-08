import type { FeedItem } from '../types.js';

export interface RssResult {
  resolvable: boolean;
  feedUrl?: string;
}

const FALLBACK_PATHS = ['/feed', '/rss.xml', '/blog/rss.xml', '/atom.xml'];

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (match) => ENTITY_MAP[match]);
}

/**
 * Extracts attribute name/value pairs from a single tag's source text (quoted
 * values only). Values are entity-decoded — markup encodes `&` as `&amp;` in
 * attribute values, so e.g. an href with a query string comes back usable.
 */
function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const name = (m[1] ?? m[3]).toLowerCase();
    const value = m[2] ?? m[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Finds a syndication feed advertised via <link rel="alternate" type="application/rss+xml|
 * application/atom+xml" href="..."> on an HTML page (case-insensitive, attribute-order agnostic).
 * Relative hrefs are resolved against baseUrl. Returns undefined when no such link exists.
 */
export function discoverFeedFromHtml(html: string, baseUrl: string): string | undefined {
  const linkTagRe = /<link\b[^>]*>/gi;
  const tags = html.match(linkTagRe) ?? [];
  for (const tag of tags) {
    const attrs = parseAttributes(tag);
    const relTokens = attrs.rel?.toLowerCase().split(/\s+/) ?? []; // rel is a space-separated token list
    const type = attrs.type?.toLowerCase();
    if (relTokens.includes('alternate') && (type === 'application/rss+xml' || type === 'application/atom+xml') && attrs.href) {
      try {
        return new URL(attrs.href, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function looksLikeFeed(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) {
      await res.body?.cancel(); // release the connection before trying the next candidate
      return false;
    }
    const body = await res.text();
    return /<rss|<feed/i.test(body);
  } catch {
    return false;
  }
}

/**
 * Resolve a working RSS/Atom feed for an account. An explicit `rss` URL is
 * tried first when provided, then the fixed list of common feed paths under
 * the domain, in order — an rss hint never reduces coverage. Stops at the
 * first 200 response whose body looks like a feed. As a final fallback,
 * fetches the account's homepage and looks for a <link rel="alternate">
 * feed advertisement, verifying it looks like a feed before returning it.
 */
export async function resolveRss(
  domain: string,
  rss?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RssResult> {
  const guessed = FALLBACK_PATHS.map((path) => `https://${domain}${path}`);
  const candidates = rss ? [rss, ...guessed.filter((url) => url !== rss)] : guessed;
  for (const url of candidates) {
    if (await looksLikeFeed(url, fetchImpl)) {
      return { resolvable: true, feedUrl: url };
    }
  }

  const homepageUrl = `https://${domain}/`;
  try {
    const res = await fetchImpl(homepageUrl, { signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { resolvable: false };
    }
    const html = await res.text();
    const discovered = discoverFeedFromHtml(html, homepageUrl);
    if (discovered && (await looksLikeFeed(discovered, fetchImpl))) {
      return { resolvable: true, feedUrl: discovered };
    }
  } catch {
    return { resolvable: false };
  }
  return { resolvable: false };
}

function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    blocks.push(m[1]);
  }
  return blocks;
}

function extractTagText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return undefined;
  let raw = m[1].trim();
  const cdataMatch = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdataMatch) raw = cdataMatch[1].trim();
  return decodeEntities(raw);
}

/** Extracts the href of an Atom <link> tag, preferring rel="alternate" (or no rel at all). */
function extractAtomLink(block: string): string | undefined {
  const tags = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback: string | undefined;
  for (const tag of tags) {
    const attrs = parseAttributes(tag);
    if (!attrs.href) continue;
    const rel = attrs.rel?.toLowerCase();
    if (!rel || rel === 'alternate') return attrs.href;
    if (fallback === undefined) fallback = attrs.href;
  }
  return fallback;
}

function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return undefined;
  return new Date(ts).toISOString().slice(0, 10);
}

function parseRssItems(xml: string): FeedItem[] {
  return extractBlocks(xml, 'item')
    .map((block): FeedItem | undefined => {
      const title = extractTagText(block, 'title') ?? '';
      const url = extractTagText(block, 'link');
      if (!url) return undefined;
      const date = toIsoDate(extractTagText(block, 'pubDate'));
      return date ? { title, url, date } : { title, url };
    })
    .filter((item): item is FeedItem => item !== undefined);
}

function parseAtomEntries(xml: string): FeedItem[] {
  return extractBlocks(xml, 'entry')
    .map((block): FeedItem | undefined => {
      const title = extractTagText(block, 'title') ?? '';
      const url = extractAtomLink(block);
      if (!url) return undefined;
      const date = toIsoDate(extractTagText(block, 'updated') ?? extractTagText(block, 'published'));
      return date ? { title, url, date } : { title, url };
    })
    .filter((item): item is FeedItem => item !== undefined);
}

/**
 * Fetches and normalizes the entries of an RSS or Atom feed into FeedItems,
 * newest-first. Items without a link are skipped. Non-200 responses or
 * bodies that don't look like a feed yield an empty array, as does any
 * fetch error.
 */
export async function fetchFeedItems(feedUrl: string, fetchImpl: typeof fetch = fetch): Promise<FeedItem[]> {
  try {
    const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) {
      await res.body?.cancel();
      return [];
    }
    const body = await res.text();
    if (!/<rss|<feed/i.test(body)) return [];

    const items = /<item\b/i.test(body) ? parseRssItems(body) : parseAtomEntries(body);
    return items.sort((a, b) => {
      const tsA = a.date ? Date.parse(a.date) : -Infinity;
      const tsB = b.date ? Date.parse(b.date) : -Infinity;
      return tsB - tsA;
    });
  } catch {
    return [];
  }
}
