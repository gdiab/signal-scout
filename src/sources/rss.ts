export interface RssResult {
  resolvable: boolean;
  feedUrl?: string;
}

const FALLBACK_PATHS = ['/feed', '/rss.xml', '/blog/rss.xml', '/atom.xml'];

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
 * first 200 response whose body looks like a feed.
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
  return { resolvable: false };
}
