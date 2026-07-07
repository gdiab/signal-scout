import type { AtsProvider, Posting } from '../types.js';

export interface ProbeResult {
  reachable: boolean;
  postingCount?: number;
  error?: string;
}

/** Thrown by fetchPostings when the ATS responds with a non-200 status. */
export class AtsHttpError extends Error {}

function buildUrl(provider: AtsProvider, slug: string): string {
  switch (provider) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  }
}

function toDatePart(input: string | number): string {
  return new Date(input).toISOString().slice(0, 10);
}

function normalizeGreenhouse(data: unknown): Posting[] {
  const jobs = Array.isArray((data as { jobs?: unknown[] })?.jobs)
    ? (data as { jobs: Array<Record<string, any>> }).jobs
    : [];
  return jobs.map((job) => ({
    id: String(job.id),
    title: job.title,
    url: job.absolute_url,
    publishedAt: toDatePart(job.updated_at),
    location: job.location?.name,
  }));
}

function normalizeLever(data: unknown): Posting[] {
  const postings = Array.isArray(data) ? (data as Array<Record<string, any>>) : [];
  return postings.map((job) => ({
    id: String(job.id),
    title: job.text,
    url: job.hostedUrl,
    publishedAt: toDatePart(job.createdAt),
    location: job.categories?.location,
  }));
}

function normalizeAshby(data: unknown): Posting[] {
  const jobs = Array.isArray((data as { jobs?: unknown[] })?.jobs)
    ? (data as { jobs: Array<Record<string, any>> }).jobs
    : [];
  return jobs.map((job) => ({
    id: String(job.id),
    title: job.title,
    url: job.jobUrl,
    publishedAt: '',
    location: job.location,
  }));
}

export async function fetchPostings(
  provider: AtsProvider,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Posting[]> {
  const url = buildUrl(provider, slug);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) {
    throw new AtsHttpError(`ATS fetch failed for ${provider}/${slug}: HTTP ${res.status}`);
  }
  const data: unknown = await res.json();
  switch (provider) {
    case 'greenhouse':
      return normalizeGreenhouse(data);
    case 'lever':
      return normalizeLever(data);
    case 'ashby':
      return normalizeAshby(data);
  }
}

export async function probeBoard(
  provider: AtsProvider,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const postings = await fetchPostings(provider, slug, fetchImpl);
    return { reachable: true, postingCount: postings.length };
  } catch (err) {
    if (err instanceof AtsHttpError) {
      return { reachable: false };
    }
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
