#!/usr/bin/env tsx
/**
 * Thin runner over probeBoard: reads a candidates JSON file, tries each
 * candidate's slug guess(es) against the ATS providers (either a per-provider
 * `slugGuesses` map, or a single `slug` guess tried across all three
 * providers), and prints one result line per account. Writes nothing —
 * curation into accounts/ai-startups.json is manual, based on this output.
 *
 * Usage: npx tsx scripts/probe-seed.ts <path-to-candidates.json>
 */
import { readFileSync } from 'node:fs';
import { probeBoard } from '../src/sources/ats.js';
import type { AtsProvider } from '../src/types.js';

interface Candidate {
  id: string;
  name: string;
  domain: string;
  group: 'core' | 'contrast';
  slug?: string; // single guess, tried across all 3 providers
  slugGuesses?: string[]; // multiple guesses, each tried across all 3 providers
}

const PROVIDERS: AtsProvider[] = ['greenhouse', 'lever', 'ashby'];
const DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAttempts(c: Candidate): Array<{ provider: AtsProvider; slug: string }> {
  const slugs = [...(c.slugGuesses ?? []), ...(c.slug ? [c.slug] : [])];
  const uniqueSlugs = [...new Set(slugs)];
  const attempts: Array<{ provider: AtsProvider; slug: string }> = [];
  for (const slug of uniqueSlugs) {
    for (const provider of PROVIDERS) attempts.push({ provider, slug });
  }
  return attempts;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npx tsx scripts/probe-seed.ts <path-to-candidates.json>');
    process.exit(1);
  }
  const candidates: Candidate[] = JSON.parse(readFileSync(path, 'utf-8'));

  let networkErrors = 0;
  let resolvedCount = 0;
  const perProvider: Record<AtsProvider, number> = { greenhouse: 0, lever: 0, ashby: 0 };

  for (const c of candidates) {
    const attempts = buildAttempts(c);
    let resolved: { provider: AtsProvider; slug: string; postingCount: number } | null = null;

    for (const { provider, slug } of attempts) {
      const result = await probeBoard(provider, slug);
      await sleep(DELAY_MS);
      if (result.error) networkErrors += 1;
      if (result.reachable) {
        resolved = { provider, slug, postingCount: result.postingCount ?? 0 };
        break;
      }
    }

    if (resolved) {
      resolvedCount += 1;
      perProvider[resolved.provider] += 1;
      console.log(
        `[${c.group}] ${c.id}: RESOLVED ${resolved.provider}/${resolved.slug} (${resolved.postingCount} postings)`,
      );
    } else {
      const tried = attempts.map((a) => `${a.provider}/${a.slug}`).join(', ') || '(no guesses)';
      console.log(`[${c.group}] ${c.id}: NONE — tried ${tried}`);
    }
  }

  console.log('---');
  console.log(
    `Resolved ${resolvedCount}/${candidates.length} (gh ${perProvider.greenhouse}, lever ${perProvider.lever}, ashby ${perProvider.ashby})`,
  );
  if (networkErrors > 30) {
    console.error(`BLOCKED: ${networkErrors} network errors (not 404s) — live network looks unavailable.`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
