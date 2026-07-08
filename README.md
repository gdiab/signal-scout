# signal-scout

An agent-run growth-signal engine with a closed experiment loop — it finds accounts showing buying signals, has an LLM agent write a cited 'why now' brief for each, and treats its scoring weights as testable hypotheses.

**Status: building.** The paragraph above describes the full design. Phase 1 — the coverage audit, the scoring engine, and a zero-credential demo mode — works end-to-end today. Live `score` works against hiring, funding, and press signal — hiring verified 2026-07-07 against the full seed list (1,008 postings across 33 live boards classified). The "why now" brief, the experiment loop, and the HTML report described above are still landing.

## Quickstart

```
git clone <repo-url>
cd signal-scout
npm i
npx tsx src/cli.ts score --demo
```

`score --demo` runs the full pipeline — audit summary, hiring-posting classification, press/funding article entity-matching (both via recorded LLM responses), and a ranked score table with full lineage (every point traces to a dated, cited event) — entirely against fictional companies in `fixtures/demo/`, with zero network calls and zero credentials required. Low-confidence press/funding matches surface in a review-queue summary rather than being silently accepted. Output is clearly labeled `⚠ synthetic demo data — fictional companies`.

```
npx tsx src/cli.ts audit --demo
```

Same synthetic fixtures, coverage-only view: for each account, whether an ATS board and an RSS feed were found.

```
npx tsx src/cli.ts audit
npx tsx src/cli.ts score
```

Runs against the real account list (`accounts/ai-startups.json`). `audit` probes live ATS boards and RSS feeds and needs no credentials. Live `score` requires `ANTHROPIC_API_KEY` (it exits with a clear error naming the variable if the key is unset, before any network call is made); with a key it fetches postings from each account's ATS and classifies them with Haiku, and fetches each account's own RSS feed plus the general news feeds in `feeds/general.json` and entity-matches the articles against the account list — hiring last verified end-to-end 2026-07-07 (1,008 postings across 33 boards, well under $1, ~15 min). Preflight lines report the exact call counts before any spend, `--max-postings` caps postings classified per account (default 40) and `--max-articles` caps articles matched per feed (default 20). Low-confidence press/funding matches are written to `review-queue.jsonl` instead of being silently accepted; every SignalEvent produced is written to `signal-events.jsonl`.

## Design principles

- **Signal-first coverage audit.** Before scoring anything, the tool audits an account list for signal *availability* (public ATS job boards, press/RSS) and reports coverage as a first-class output, not an internal step.
- **Synthetic demo data, clearly labeled.** `--demo` runs entirely on fictional companies with `.example` domains and recorded LLM responses — no real company names, no network calls, no API key required. Every place demo output surfaces (fixtures, CLI output, README) labels it as synthetic. See `docs/adr/0002-fictional-companies-in-demo-fixtures.md`.
- **Weights as hypotheses.** Playbook scoring weights carry an explicit hypothesis and a status (`untested | supported | refuted`), intended to be updated by comparing outcomes for accounts with vs. without a signal.
- **LLM-only entity matching, no embeddings.** See `docs/adr/0001-llm-only-entity-matching.md`.
- **Funding via press, not SEC Form D (for now).** See `docs/adr/0003-funding-via-press-form-d-deferred.md`.

## Architecture decisions

See `docs/adr/` for the full rationale behind decisions made during design:

- [0001 — LLM-only entity matching (no embeddings)](docs/adr/0001-llm-only-entity-matching.md)
- [0002 — Fictional companies in demo fixtures](docs/adr/0002-fictional-companies-in-demo-fixtures.md)
- [0003 — Funding via press, SEC Form D deferred](docs/adr/0003-funding-via-press-form-d-deferred.md)

## Development

```
npm i
npm run typecheck
npm test
```

## License

MIT — see [LICENSE](LICENSE).
