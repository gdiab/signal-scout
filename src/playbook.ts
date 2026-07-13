import { readFileSync } from 'node:fs';
import type { Compound, HiringLabel, Playbook, SignalType, Weight } from './types.js';

const SIGNAL_TYPES: SignalType[] = ['hiring', 'funding', 'press'];
const STATUSES = ['untested', 'supported', 'refuted'];

function fail(field: string, detail: string): never {
  throw new Error(`invalid playbook: ${field} ${detail}`);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateHalfLifeDays(raw: unknown): asserts raw is Record<SignalType, number> {
  if (typeof raw !== 'object' || raw === null) {
    fail('halfLifeDays', 'must be an object');
  }
  const obj = raw as Record<string, unknown>;
  for (const type of SIGNAL_TYPES) {
    const value = obj[type];
    if (typeof value !== 'number' || !(value > 0)) {
      fail(`halfLifeDays.${type}`, 'must be a positive number');
    }
  }
}

function validateHiringLabel(raw: unknown, index: number): asserts raw is HiringLabel {
  if (typeof raw !== 'object' || raw === null) {
    fail(`hiringLabels[${index}]`, 'must be an object');
  }
  const l = raw as Record<string, unknown>;
  if (!isNonEmptyString(l.id)) {
    fail(`hiringLabels[${index}].id`, 'must be a nonempty string');
  }
  if (l.id === 'other') {
    fail(`hiringLabels[${index}].id`, "must not be 'other' (the implicit fallback label)");
  }
  if (l.description !== undefined && !isNonEmptyString(l.description)) {
    fail(`hiringLabels[${index}].description`, 'must be a nonempty string when present');
  }
  if (l.reclassifyAtCount !== undefined) {
    if (typeof l.reclassifyAtCount !== 'object' || l.reclassifyAtCount === null) {
      fail(`hiringLabels[${index}].reclassifyAtCount`, 'must be an object when present');
    }
    const r = l.reclassifyAtCount as Record<string, unknown>;
    if (typeof r.threshold !== 'number' || !Number.isInteger(r.threshold) || r.threshold <= 0) {
      fail(`hiringLabels[${index}].reclassifyAtCount.threshold`, 'must be a positive integer');
    }
    if (!isNonEmptyString(r.to)) {
      fail(`hiringLabels[${index}].reclassifyAtCount.to`, 'must be a nonempty string');
    }
    if (r.to === 'other') {
      fail(`hiringLabels[${index}].reclassifyAtCount.to`, "must not be 'other'");
    }
  }
}

function validateWeight(raw: unknown, index: number): asserts raw is Weight {
  if (typeof raw !== 'object' || raw === null) {
    fail(`weights[${index}]`, 'must be an object');
  }
  const w = raw as Record<string, unknown>;
  if (!isNonEmptyString(w.id)) {
    fail(`weights[${index}].id`, 'must be a nonempty string');
  }
  if (typeof w.signalType !== 'string' || !SIGNAL_TYPES.includes(w.signalType as SignalType)) {
    fail(`weights[${index}].signalType`, `must be one of ${SIGNAL_TYPES.join(', ')}`);
  }
  if (w.subtype !== undefined && typeof w.subtype !== 'string') {
    fail(`weights[${index}].subtype`, 'must be a string when present');
  }
  if (typeof w.points !== 'number') {
    fail(`weights[${index}].points`, 'must be a number');
  }
  if (w.maxEventsPerAccount !== undefined) {
    if (typeof w.maxEventsPerAccount !== 'number' || !Number.isInteger(w.maxEventsPerAccount) || w.maxEventsPerAccount <= 0) {
      const idSuffix = isNonEmptyString(w.id) ? ` (id "${w.id}")` : '';
      fail(`weights[${index}].maxEventsPerAccount${idSuffix}`, 'must be a positive integer when present');
    }
  }
  if (!isNonEmptyString(w.hypothesis)) {
    fail(`weights[${index}].hypothesis`, 'must be a nonempty string');
  }
  if (typeof w.status !== 'string' || !STATUSES.includes(w.status)) {
    fail(`weights[${index}].status`, `must be one of ${STATUSES.join(', ')}`);
  }
}

function validateCompound(raw: unknown, index: number, weightIds: Set<string>): asserts raw is Compound {
  if (typeof raw !== 'object' || raw === null) {
    fail(`compounds[${index}]`, 'must be an object');
  }
  const c = raw as Record<string, unknown>;
  if (!isNonEmptyString(c.id)) {
    fail(`compounds[${index}].id`, 'must be a nonempty string');
  }
  if (!Array.isArray(c.requiresWeightIds) || c.requiresWeightIds.length !== 2) {
    fail(`compounds[${index}].requiresWeightIds`, 'must be a tuple of exactly two weight ids');
  }
  const [a, b] = c.requiresWeightIds as unknown[];
  if (!isNonEmptyString(a) || !isNonEmptyString(b)) {
    fail(`compounds[${index}].requiresWeightIds`, 'must contain nonempty string weight ids');
  }
  for (const weightId of [a, b] as string[]) {
    if (!weightIds.has(weightId)) {
      fail(`compounds[${index}].requiresWeightIds`, `references unknown weight id "${weightId}"`);
    }
  }
  if (typeof c.withinDays !== 'number' || !(c.withinDays > 0)) {
    fail(`compounds[${index}].withinDays`, 'must be a positive number');
  }
  if (typeof c.multiplier !== 'number') {
    fail(`compounds[${index}].multiplier`, 'must be a number');
  }
  if (!isNonEmptyString(c.hypothesis)) {
    fail(`compounds[${index}].hypothesis`, 'must be a nonempty string');
  }
  if (typeof c.status !== 'string' || !STATUSES.includes(c.status)) {
    fail(`compounds[${index}].status`, `must be one of ${STATUSES.join(', ')}`);
  }
}

export function loadPlaybook(path: string): Playbook {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('playbook', 'must be an object');
  }
  const raw = parsed as Record<string, unknown>;

  if (!isNonEmptyString(raw.name)) {
    fail('name', 'must be a nonempty string');
  }
  if (!isNonEmptyString(raw.description)) {
    fail('description', 'must be a nonempty string');
  }
  validateHalfLifeDays(raw.halfLifeDays);

  if (!Array.isArray(raw.hiringLabels) || raw.hiringLabels.length === 0) {
    fail('hiringLabels', 'must be a nonempty array');
  }
  raw.hiringLabels.forEach((l, i) => validateHiringLabel(l, i));
  const hiringLabels = raw.hiringLabels as HiringLabel[];
  const labelIds = new Set(hiringLabels.map((l) => l.id));
  if (labelIds.size !== hiringLabels.length) {
    fail('hiringLabels', 'label ids must be unique');
  }
  const validSubtypes = new Set(labelIds);
  for (const label of hiringLabels) {
    const to = label.reclassifyAtCount?.to;
    if (to === undefined) continue;
    if (labelIds.has(to)) {
      fail(`hiringLabels (label "${label.id}")`, `reclassifyAtCount.to "${to}" collides with a declared label id`);
    }
    validSubtypes.add(to);
  }

  if (!Array.isArray(raw.weights)) {
    fail('weights', 'must be an array');
  }
  raw.weights.forEach((w, i) => validateWeight(w, i));
  const weights = raw.weights as Weight[];
  const weightIds = new Set(weights.map(w => w.id));

  for (const w of weights) {
    if (w.signalType === 'hiring' && w.subtype !== undefined && !validSubtypes.has(w.subtype)) {
      fail(`weights (id "${w.id}").subtype`, `"${w.subtype}" is not a declared hiring label or reclassify target`);
    }
  }

  if (!Array.isArray(raw.compounds)) {
    fail('compounds', 'must be an array');
  }
  raw.compounds.forEach((c, i) => validateCompound(c, i, weightIds));
  const compounds = raw.compounds as Compound[];

  return {
    name: raw.name,
    description: raw.description,
    halfLifeDays: raw.halfLifeDays,
    hiringLabels,
    weights,
    compounds,
  };
}
