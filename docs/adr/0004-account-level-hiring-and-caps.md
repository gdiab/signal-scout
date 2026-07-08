# 0004: Account-level hiring semantics, per-weight caps, honest undated decay

**Status:** accepted

## Context

A live scoring run against a Notion-sized account surfaced a defect: the hiring classifier labels each job posting independently, with no visibility into the account's other postings. A company running a full GTM org — many simultaneously open GTM roles — got every one of those postings labeled `first-gtm` (40 points each), stacking to a score of 770. That is the opposite of the hypothesis behind the weight: a *first* GTM hire is a receptivity signal precisely because the motion isn't staffed yet. Once it's staffed several times over, more open GTM roles are evidence of expansion, not a first-hire window.

The same run exposed a second issue: Ashby-sourced postings omit a publish date entirely, so roughly two-thirds of live hiring events had no date to decay against. Scoring was filling the gap with `asOf`, which decays those events at age zero — full points, forever fresh, for postings that could in fact be old. That's not a decay bug so much as a missing-data bug wearing a decay bug's clothes.

Both defects share a root cause: the scorer trusted per-event signals without accounting for what it doesn't actually know — how many similar events exist on the same account, or how old an undated event really is.

## Decision

Three changes, all landing at the point where per-event signal becomes account-level score:

1. **Account-level hiring demotion.** After classifying all of an account's postings, count events labeled `first-gtm`. If more than 2, relabel all of them `gtm-expansion` — a new, lower-weight subtype whose hypothesis is explicitly about volume, not novelty. This is a post-pass over the classifier's output, not a change to the per-posting classification itself, so the classifier stays simple and stateless.

2. **Per-weight caps.** Each weight in a playbook may declare `maxEventsPerAccount`. Scoring sorts that weight's contributing events for an account by points and keeps only the top K, dropping the rest before totaling and before compound activation. `w-first-gtm` gets a cap of 1 (belt-and-suspenders alongside the demotion rule above), `w-growth-eng`/`w-ai-eng` cap at 3, `w-generic-eng` and `w-press` at 5, the new `w-gtm-expansion` at 3. `w-funding-180` stays uncapped — funding rounds are rare enough that a cap would never bind.

3. **Honest decay for undated events.** An event with no source date gets `dateEstimated: true` and a flat 0.5 decay factor — an honest midpoint assumption, not a guess dressed up as a fresh signal — and is excluded from compound activation, since an undated event can't prove it happened within a compound's day window.

## Consequences

- No single weight can dominate an account's score regardless of how many matching postings or articles exist; total contribution per weight per account is bounded.
- "First GTM hire" now means what it says: it only fires when the account looks like it's making its first hire into that motion, not whenever any GTM req is open.
- Undated events (a real gap in ATS provider data, not a project choice) are discounted rather than silently treated as fresh, and can't trigger compound multipliers they can't actually justify.
- Playbook authors get an explicit lever (`maxEventsPerAccount`) for any future weight prone to the same stacking failure, without needing a bespoke post-pass like the hiring one.
