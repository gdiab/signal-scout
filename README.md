# signal-scout

An agent-run growth-signal engine with a closed experiment loop — it finds accounts showing buying signals, has an LLM agent write a cited "why now" brief for each, and treats its scoring weights as testable hypotheses.

## Quickstart

The whole loop runs offline against fictional companies in about a second — no API key, no network:

```
git clone <repo-url>
cd signal-scout
npm i
npx tsx src/cli.ts score --demo --report
```

What appears, in order: a signal-availability **audit** (which accounts have a reachable ATS job board / RSS feed), a ranked **score table** with full lineage (every point traces to a dated, cited event), three cited **"why now" briefs**, a **review-queue** summary (one low-confidence press match that a human should look at rather than the pipeline silently accepting it), and a **lift table** computed from a recorded outcome log — the experiment loop closing in one command. It also writes `report.html`, a self-contained HTML report of the same run (no server, no external assets, no JS — safe to open straight from the clone).

The hiring classification and press/funding entity matching run through the exact same pipeline live mode uses, driven by recorded LLM responses. Everything is synthetic — fictional companies with `.example` domains — and every surface says so: output ends with `⚠ synthetic demo data — fictional companies`.

**Status:** the full design above is built and working — coverage audit, hiring + funding + press signals, scoring with recency decay and compound bonuses, cited briefs, the review queue, the experiment loop (`lift`), and the HTML report. Live mode last verified end-to-end 2026-07-08 (numbers below).

## The other commands

```
npx tsx src/cli.ts lift --demo
```

Just the experiment loop: for each playbook weight, compares outcome rates (contacted → replied) for accounts WITH vs WITHOUT that weight's contribution and suggests `status` updates (`supported | refuted | inconclusive`), honestly caveated at small n. Suggestions are proposals — the command never edits the playbook file.

```
npx tsx src/cli.ts audit --demo
```

Same synthetic fixtures, coverage-only view: for each account, whether an ATS board and an RSS feed were found.

## Live mode

```
npx tsx src/cli.ts audit
npx tsx src/cli.ts score
```

Runs against the real account list (`accounts/ai-startups.json`): 30 Series A–D AI/dev-tools startups (core) plus 10 deliberately-offline contrast accounts (regional healthcare, freight, equipment manufacturers). `audit` probes live ATS boards and RSS feeds and needs no credentials.

Live `score` requires `ANTHROPIC_API_KEY` (it exits with a clear error naming the variable if the key is unset, before any network call is made). With a key it fetches postings from each account's ATS and classifies them with Haiku (`claude-haiku-4-5`), fetches each account's own RSS feed plus the general news feeds in `feeds/general.json`, and entity-matches the articles against the account list with the same model. Briefs are written with `claude-sonnet-5` for the top 10 scored accounts.

Spend is always announced before it happens: preflight lines report the exact LLM call counts before any classification starts, `--max-postings` caps postings classified per account (default 40, most recent first) and `--max-articles` caps articles matched per feed (default 20). Every SignalEvent produced is written to `signal-events.jsonl`; low-confidence press/funding matches are written to `review-queue.jsonl` instead of being silently accepted.

**Last full live run — 2026-07-08:** classified 964 postings across 33 live boards (1,390 more postings sat beyond the 40-per-account cap), entity-matched 267 articles, and wrote 10 briefs with `claude-sonnet-5` — roughly 1,200 Haiku calls plus 10 Sonnet calls, well under $2 of API spend, ~26 minutes wall time with politeness delays. The review queue was empty that run (every accepted match cleared the confidence bar). Audit coverage from the same run: core `ATS 30/30 (100%) · RSS 10/30 (33%)`, contrast `ATS 3/10 (30%) · RSS 4/10 (40%)` — low RSS coverage among the core accounts is a real finding about modern startup marketing sites (they mostly don't publish discoverable feeds), not a bug; the audit exists to surface exactly that.

## The experiment loop

Scoring weights are hypotheses, and the loop is the product. Each weight in `playbooks/ai-startups.json` carries an explicit `hypothesis` and a `status` (`untested | supported | refuted`). To test them against reality:

1. Run live `score` — it snapshots every signal event to `signal-events.jsonl`.
2. Log your outreach outcomes to `events.jsonl` (append-only, one JSON object per line: `{"accountId": "...", "stage": "contacted" | "replied" | ..., "date": "yyyy-mm-dd"}`) from your CRM or by hand.
3. Run the loop:

```
npx tsx src/cli.ts lift
```

No LLM calls, no API key: it re-scores from the `signal-events.jsonl` snapshot, joins your outcome log, and for each weight compares outcome rates for accounts with vs. without that signal — suggesting `status` updates with explicit small-n caveats. Live `score` also appends the lift table to its own output whenever `events.jsonl` exists, so once you're logging outcomes the loop closes in one command.

## The review queue

Entity matching is LLM-only — one Haiku call per candidate article against the full account list, no embeddings, no alias CSVs (ADR 0001). Any match below the 0.6 confidence bar is never silently attached to an account: it produces no signal event, lands in `review-queue.jsonl`, and surfaces in the score output as a "needs a human" summary. The demo includes a deliberately ambiguous article so you can see the queue working.

## Date honesty

Some sources omit dates entirely (Ashby job boards, some feeds). Rather than treating undated events as fresh forever, scoring marks them `dateEstimated` and applies a flat 0.5 decay — an honest midpoint assumption — and excludes them from compound bonuses, since an undated event can't prove it happened within a compound's day window (ADR 0004). Briefs are held to the same standard: they may cite only URLs that belong to the account's actual events, and any other URL in a brief is flagged with an `⚠ uncited claims` warning rather than passed through.

## Design principles

- **Signal-first coverage audit.** Before scoring anything, the tool audits an account list for signal *availability* (public ATS job boards, press/RSS) and reports coverage as a first-class output, not an internal step.
- **Synthetic demo data, clearly labeled.** `--demo` runs entirely on fictional companies with `.example` domains and recorded LLM responses — no real company names, no network calls, no API key required. Every place demo output surfaces labels it as synthetic. See `docs/adr/0002-fictional-companies-in-demo-fixtures.md`.
- **Weights as hypotheses.** The `lift` command compares outcomes for accounts with vs. without each signal and suggests status updates — proposals only, honestly caveated at small n.
- **LLM-only entity matching, no embeddings.** Low-confidence matches go to a human review queue. See `docs/adr/0001-llm-only-entity-matching.md`.
- **Funding via press, not SEC Form D (for now).** See `docs/adr/0003-funding-via-press-form-d-deferred.md`.
- **Honest uncertainty beats false precision.** Undated events are flat-discounted, per-weight caps stop any single signal from stacking unboundedly, and one account's posting volume can't masquerade as a "first hire" signal. See `docs/adr/0004-account-level-hiring-and-caps.md`.

## Architecture decisions

See `docs/adr/` for the full rationale behind decisions made during design:

- [0001 — LLM-only entity matching (no embeddings)](docs/adr/0001-llm-only-entity-matching.md)
- [0002 — Fictional companies in demo fixtures](docs/adr/0002-fictional-companies-in-demo-fixtures.md)
- [0003 — Funding via press, SEC Form D deferred](docs/adr/0003-funding-via-press-form-d-deferred.md)
- [0004 — Account-level hiring semantics, per-weight caps, honest undated decay](docs/adr/0004-account-level-hiring-and-caps.md)

## Development

```
npm i
npm run typecheck
npm test
```

## License

MIT — see [LICENSE](LICENSE).
