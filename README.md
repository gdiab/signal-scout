# signal-scout

An agent-run growth-signal engine with a closed experiment loop — it finds accounts showing buying signals, has an LLM agent write a cited 'why now' brief for each, and treats its scoring weights as testable hypotheses.

**Status: building.** This repo currently contains the project scaffold (CI, license, ADRs) only. There is no `src/` yet, no CLI to run, and no data to inspect. The sections below describe the design this project is being built toward, not shipped functionality.

## Quickstart

Not runnable yet. Once the CLI lands, this section will show the exact commands for a fresh clone, including a zero-credential demo mode:

```
npm i
npx tsx src/cli.ts audit
npx tsx src/cli.ts score --demo
```

## Design principles

- **Signal-first coverage audit.** Before scoring anything, the tool will audit an account list for signal *availability* (public ATS job boards, press/RSS) and report coverage as a first-class output, not an internal step.
- **Synthetic demo data, clearly labeled.** When a `--demo` mode ships, it will run entirely on fictional companies with `.example` domains and mocked LLM responses — no real company names, no network calls, no API key required. Every place demo output surfaces (fixtures, report, README) will label it as synthetic. See `docs/adr/0002-fictional-companies-in-demo-fixtures.md`.
- **Weights as hypotheses.** Playbook scoring weights will carry an explicit hypothesis and a status (`untested | supported | refuted`), updated by comparing outcomes for accounts with vs. without a signal.
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
