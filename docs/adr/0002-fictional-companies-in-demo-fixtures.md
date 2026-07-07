# 0002: Fictional companies in demo fixtures

**Status:** accepted

## Context

Demo mode (`--demo`) needs seeded signal data — hiring postings, funding events, press mentions — so the full pipeline (audit → score → brief → report) runs end-to-end with zero credentials and no network calls.

Labeling synthetic output as synthetic (in the fixtures directory, the report footer, the README) is necessary but not sufficient. A screenshot, a copy-pasted report snippet, or a quoted brief loses its surrounding label the moment it's separated from the page it appeared on. If a fabricated funding event or hiring spike is attached to a real company name, that fabrication can end up looking like a real claim about a real company in any context where the label didn't travel with it.

## Decision

Demo fixtures use entirely invented companies with `.example`-TLD (or clearly synthetic `demo-`-prefixed) domains — never real company names, even though the data is already labeled as demo. Real companies only ever appear in the live account list (`accounts/ai-startups.json`), never in a fixture.

Labeling (fixtures dir, report footer, README) remains in place as defense-in-depth, on top of — not instead of — fictional names.

## Consequences

- Demo fixtures cannot reuse real company research as a shortcut; ~15-20 invented startups must be authored deliberately.
- No fabricated signal can ever be mistaken for a real claim about a real company, regardless of how the output is excerpted or shared.
- The README may still show a dated, labeled example of a *real* audit run (live mode) — this decision only constrains `--demo` fixtures, not live output.
