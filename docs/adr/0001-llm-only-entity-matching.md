# 0001: LLM-only entity matching (no embeddings)

**Status:** accepted

## Context

The press/RSS signal needs to match articles against a list of ~30 tracked accounts. Fuzzy name matching (alias CSVs, string-distance heuristics) is the classic failure mode here — legal names, brand names, and DBAs drift apart and the alias list becomes a permanent maintenance tarpit.

An embedding-based shortlist (embed account names/domains and articles, retrieve nearest candidates before a final match step) is the standard way to make entity matching scale. But it solves a scale problem this tool doesn't have: at ~30 accounts, every candidate article can simply be checked against the full account list in one LLM call, with no retrieval step needed.

Anthropic is the only LLM provider this project uses, and Anthropic has no embeddings API. Adding a second provider purely to get embeddings would violate the project's scope discipline and would muddy the zero-credential demo path (a second provider means a second credential surface, even if only exercised in live mode).

## Decision

Entity matching is done with a single LLM call per candidate article: the call receives all account names and domains and returns the matched account (or none) with a confidence score. There is no embedding shortlist and no alias-CSV.

Low-confidence matches are never silently accepted — they are routed to a human-review queue file instead of being auto-matched.

## Consequences

- No second LLM provider, no embeddings dependency, no alias-CSV to maintain.
- Matching cost scales linearly with (accounts x articles); acceptable at the ~30-account scale this tool targets. Revisit if the account list grows an order of magnitude.
- Low-confidence matches require a human-review step rather than being fully automatic — this is a deliberate accuracy-over-automation tradeoff, not an oversight.
