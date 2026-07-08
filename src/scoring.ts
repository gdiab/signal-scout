import type {
  Account,
  SignalEvent,
  Playbook,
  Weight,
  Contribution,
  ScoredAccount,
} from './types.js';

const MS_PER_DAY = 86400000;

interface MatchedEvent {
  event: SignalEvent;
  weight: Weight;
  contribution: Contribution;
  future: boolean; // future-dated: contributes 0 and cannot activate compounds
}

/** Find the highest-points weight that matches this event's type/subtype, if any. */
function matchWeight(event: SignalEvent, weights: Weight[]): Weight | undefined {
  let best: Weight | undefined;
  for (const w of weights) {
    if (w.signalType !== event.type) continue;
    if (w.subtype !== undefined && w.subtype !== event.subtype) continue;
    if (best === undefined || w.points > best.points) best = w;
  }
  return best;
}

/**
 * Score accounts against events per playbook, as of a given ISO date.
 * Pure function: no I/O, no Date.now(), no randomness.
 */
export function scoreAccounts(
  accounts: Account[],
  events: SignalEvent[],
  playbook: Playbook,
  asOf: string,
): ScoredAccount[] {
  const asOfMs = Date.parse(asOf);
  const results: ScoredAccount[] = [];

  for (const account of accounts) {
    const accountEvents = events.filter((e) => e.accountId === account.id);
    const matched: MatchedEvent[] = [];

    for (const event of accountEvents) {
      const weight = matchWeight(event, playbook.weights);
      if (!weight) continue;

      const eventMs = Date.parse(event.date);
      const ageDays = Math.floor((asOfMs - eventMs) / MS_PER_DAY);

      let decayFactor: number;
      let points: number;
      if (ageDays < 0) {
        decayFactor = 0;
        points = 0;
      } else if (event.dateEstimated) {
        // No source date to trust: assume one half-life old rather than crediting
        // full freshness. Honest midpoint, never fresher than a dated event at age 0.
        decayFactor = 0.5;
        points = weight.points * 0.5;
      } else {
        const halfLife = playbook.halfLifeDays[event.type];
        decayFactor = Math.pow(0.5, ageDays / halfLife);
        points = weight.points * decayFactor;
      }

      const contribution: Contribution = {
        weightId: weight.id,
        eventId: event.id,
        eventUrl: event.url,
        eventDate: event.date,
        basePoints: weight.points,
        decayFactor,
        points,
      };

      matched.push({ event, weight, contribution, future: ageDays < 0 });
    }

    // Per-weight caps: for weights with maxEventsPerAccount, keep only the top-K
    // contributions (by points desc) for this account; dropped ones vanish from
    // contributions and cannot activate compounds. Skipped when no weight caps.
    let effectiveMatched = matched;
    const cappedWeightIds = playbook.weights
      .filter((w) => w.maxEventsPerAccount !== undefined)
      .map((w) => w.id);
    if (cappedWeightIds.length > 0) {
      const dropped = new Set<string>();
      for (const weightId of cappedWeightIds) {
        const forWeight = matched.filter((m) => m.weight.id === weightId);
        const cap = forWeight[0]?.weight.maxEventsPerAccount;
        if (cap === undefined || forWeight.length <= cap) continue;
        const overflow = [...forWeight]
          .sort((a, b) => b.contribution.points - a.contribution.points)
          .slice(cap);
        for (const m of overflow) dropped.add(m.event.id);
      }
      effectiveMatched = matched.filter((m) => !dropped.has(m.event.id));
    }

    const baseScore = effectiveMatched.reduce((sum, m) => sum + m.contribution.points, 0);

    const compoundsApplied: { compoundId: string; multiplier: number }[] = [];
    let multiplier = 1;

    // Only non-future, dated (actually contributing) events can activate compounds —
    // an estimated date can't prove a within-N-days window.
    const contributing = effectiveMatched.filter((m) => !m.future && !m.event.dateEstimated);

    for (const compound of playbook.compounds) {
      const [idA, idB] = compound.requiresWeightIds;
      const eventsA = contributing.filter((m) => m.weight.id === idA);
      const eventsB = contributing.filter((m) => m.weight.id === idB);
      if (eventsA.length === 0 || eventsB.length === 0) continue;

      let withinWindow = false;
      for (const a of eventsA) {
        const aMs = Date.parse(a.event.date);
        for (const b of eventsB) {
          const bMs = Date.parse(b.event.date);
          const diffDays = Math.abs(aMs - bMs) / MS_PER_DAY;
          if (diffDays <= compound.withinDays) {
            withinWindow = true;
            break;
          }
        }
        if (withinWindow) break;
      }

      if (withinWindow) {
        compoundsApplied.push({ compoundId: compound.id, multiplier: compound.multiplier });
        multiplier *= compound.multiplier;
      }
    }

    const score = baseScore * multiplier;

    results.push({
      accountId: account.id,
      score,
      contributions: effectiveMatched.map((m) => m.contribution),
      compoundsApplied,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
