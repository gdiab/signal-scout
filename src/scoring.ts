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

    const baseScore = matched.reduce((sum, m) => sum + m.contribution.points, 0);

    const compoundsApplied: { compoundId: string; multiplier: number }[] = [];
    let multiplier = 1;

    // Only non-future (actually contributing) events can activate compounds.
    const contributing = matched.filter((m) => !m.future);

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
      contributions: matched.map((m) => m.contribution),
      compoundsApplied,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
