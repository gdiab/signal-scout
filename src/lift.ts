import type { LiftRow, OutcomeEvent, Playbook, ScoredAccount } from './types.js';

export interface LiftOptions {
  attemptStages?: string[];   // default ['contacted', 'applied']
  successStages?: string[];   // default ['replied', 'responded']
  minN?: number;              // default 3
}

const DEFAULT_ATTEMPT_STAGES = ['contacted', 'applied'];
const DEFAULT_SUCCESS_STAGES = ['replied', 'responded'];
const DEFAULT_MIN_N = 3;

const SUPPORTED_RATIO = 1.5;
const REFUTED_RATIO = 0.67;

/**
 * Compares outcome rates for accounts WITH vs WITHOUT each playbook weight's
 * contribution, and suggests a `status` update per weight — honestly caveated
 * at small n. Pure: no I/O, no Date.now().
 *
 * "Has" a weight iff the account's ScoredAccount.contributions include a
 * contribution with that weightId (any contribution — points may have
 * decayed to near zero, but the event still matched the weight). "Attempted"
 * = at least one outcome event in an attempt stage; "succeeded" = attempted
 * AND at least one outcome event in a success stage (an account with a
 * success-stage outcome but no attempt-stage one does not count — you can't
 * reply to an outreach that was never sent).
 */
export function computeLift(
  scored: ScoredAccount[],
  outcomes: OutcomeEvent[],
  playbook: Playbook,
  opts: LiftOptions = {},
): LiftRow[] {
  const attemptStages = new Set(opts.attemptStages ?? DEFAULT_ATTEMPT_STAGES);
  const successStages = new Set(opts.successStages ?? DEFAULT_SUCCESS_STAGES);
  const minN = opts.minN ?? DEFAULT_MIN_N;

  const outcomesByAccount = new Map<string, OutcomeEvent[]>();
  for (const o of outcomes) {
    const list = outcomesByAccount.get(o.accountId);
    if (list) list.push(o);
    else outcomesByAccount.set(o.accountId, [o]);
  }

  function attempted(accountId: string): boolean {
    const events = outcomesByAccount.get(accountId);
    return !!events && events.some((e) => attemptStages.has(e.stage));
  }

  function succeeded(accountId: string): boolean {
    if (!attempted(accountId)) return false;
    const events = outcomesByAccount.get(accountId);
    return !!events && events.some((e) => successStages.has(e.stage));
  }

  return playbook.weights.map((weight) => {
    const hasWeight = new Set(
      scored
        .filter((s) => s.contributions.some((c) => c.weightId === weight.id))
        .map((s) => s.accountId),
    );

    let withAttempted = 0;
    let withSucceeded = 0;
    let withoutAttempted = 0;
    let withoutSucceeded = 0;

    for (const s of scored) {
      const isAttempted = attempted(s.accountId);
      const isSucceeded = succeeded(s.accountId);
      if (hasWeight.has(s.accountId)) {
        if (isAttempted) withAttempted++;
        if (isSucceeded) withSucceeded++;
      } else {
        if (isAttempted) withoutAttempted++;
        if (isSucceeded) withoutSucceeded++;
      }
    }

    const withRate = withAttempted > 0 ? withSucceeded / withAttempted : null;
    const withoutRate = withoutAttempted > 0 ? withoutSucceeded / withoutAttempted : null;

    const caveats: string[] = [];
    let suggestion: LiftRow['suggestion'];

    if (withAttempted < minN || withoutAttempted < minN) {
      suggestion = 'inconclusive';
      caveats.push(`small n (with=${withAttempted}, without=${withoutAttempted}) — directional at best`);
    } else if (withRate === null || withoutRate === null) {
      // Only reachable when a caller passes minN <= 0: a null rate means zero
      // attempts on that side, and no attempts can't support or refute anything.
      suggestion = 'inconclusive';
    } else if (withoutRate === 0) {
      suggestion = withRate > 0 ? 'supported' : 'inconclusive';
    } else {
      const ratio = withRate / withoutRate;
      if (ratio >= SUPPORTED_RATIO) suggestion = 'supported';
      else if (ratio <= REFUTED_RATIO) suggestion = 'refuted';
      else suggestion = 'inconclusive';
    }

    return {
      weightId: weight.id,
      withAttempted,
      withSucceeded,
      withoutAttempted,
      withoutSucceeded,
      withRate,
      withoutRate,
      suggestion,
      caveats,
    };
  });
}
