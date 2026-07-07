# 0003: Funding via press, SEC Form D deferred

**Status:** accepted

## Context

Funding events are a strong buying signal, and there are two ways to detect them: SEC Form D filings (structured, authoritative) or press coverage (unstructured, but where funding news actually shows up first and most reliably for this vertical).

Form D reintroduces the legal-name-to-brand-name matching problem this project otherwise avoids (ADR 0001) — Form D filings use the issuer's legal entity name, which frequently differs from the brand name a company is tracked under. Its coverage is also spottier than it first appears: filings are frequently made late, so "no Form D yet" does not mean "no funding yet."

The press/RSS signal pipeline already runs an LLM call per candidate article to entity-match it to an account (ADR 0001). That same call can be extended to classify the article's type (`funding | product | hiring | other`) and extract a date and amount when present, at no additional infrastructure cost.

## Decision

Funding detection rides on the existing press pipeline: the entity-matching LLM call also classifies article type and extracts date/amount when parseable. A "raised in the last 180 days" boolean, with date and amount when available, is the funding signal.

`funding` remains a first-class signal type in the schema and in playbook weights, independent of how it's detected. Signal *types* and signal *sources* are deliberately decoupled so that adding Form D as an additional source later is additive (a new detector feeding the same `funding` signal type) rather than a schema or scoring refactor.

Form D ingestion is explicitly deferred, not rejected.

## Consequences

- No legal-name/brand-name alias matching is needed for funding in the current scope.
- Funding coverage is bounded by press coverage: funding that isn't announced or covered won't be detected. The audit reports this as a coverage rate rather than presenting funding data as complete.
- Adding Form D later only requires a new detector that emits the same `funding` signal shape — no changes to scoring, playbook config, or the signal schema.
