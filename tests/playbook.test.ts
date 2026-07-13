import { describe, it, expect } from 'vitest';
import { loadPlaybook } from '../src/playbook.js';

describe('loadPlaybook', () => {
  it('loads the ai-startups playbook with 7 weights and 1 compound', () => {
    const pb = loadPlaybook('playbooks/ai-startups.json');
    expect(pb.name).toBe('ai-startups');
    expect(pb.weights).toHaveLength(7);
    expect(pb.compounds).toHaveLength(1);
    expect(pb.weights.every(w => w.hypothesis.length > 0)).toBe(true);
    expect(pb.weights.every(w => ['untested','supported','refuted'].includes(w.status))).toBe(true);
  });
  it('rejects a playbook with a compound referencing unknown weight ids', () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook.json')).toThrow(/unknown weight/i);
  });
  it('rejects a file whose JSON root is not an object', () => {
    expect(() => loadPlaybook('tests/fixtures/null-playbook.json')).toThrow(/must be an object/i);
  });
  it('rejects a weight with a non-positive-integer maxEventsPerAccount, naming the offending weight id', () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-cap.json')).toThrow(/maxEventsPerAccount/i);
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-cap.json')).toThrow(/w-press/);
  });
  it('loads hiringLabels from the ai-startups playbook: four labels, first-gtm carries the reclassify rule', () => {
    const pb = loadPlaybook('playbooks/ai-startups.json');
    expect(pb.hiringLabels.map((l) => l.id)).toEqual(['growth-eng', 'first-gtm', 'ai-eng', 'generic-eng']);
    const firstGtm = pb.hiringLabels.find((l) => l.id === 'first-gtm');
    expect(firstGtm?.reclassifyAtCount).toEqual({ threshold: 3, to: 'gtm-expansion' });
    expect(pb.hiringLabels.every((l) => l.description === undefined)).toBe(true);
  });
  it('rejects a hiring weight whose subtype is not a declared label or reclassify target', () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-label-subtype.json')).toThrow(/subtype/i);
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-label-subtype.json')).toThrow(/no-such-label/);
  });
  it("rejects a declared label named 'other'", () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-label-other.json')).toThrow(/other/i);
  });
  it('rejects a reclassifyAtCount target that collides with a declared label id', () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-reclass-collision.json')).toThrow(/collid|declared/i);
  });
  it('rejects a press weight whose subtype is not "article", naming the offending weight id', () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-press-subtype.json')).toThrow(/subtype/i);
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-press-subtype.json')).toThrow(/w-press/);
  });
  it('rejects a funding weight whose subtype is not "round", naming the offending weight id', () => {
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-funding-subtype.json')).toThrow(/subtype/i);
    expect(() => loadPlaybook('tests/fixtures/bad-playbook-funding-subtype.json')).toThrow(/w-funding-180/);
  });
  it('loads the ai-adopters playbook: described labels, 6 weights, 1 compound', () => {
    const pb = loadPlaybook('playbooks/ai-adopters.json');
    expect(pb.name).toBe('ai-adopters');
    expect(pb.hiringLabels.map((l) => l.id)).toEqual(['ai-adoption', 'ai-eng', 'data-platform', 'generic-eng']);
    expect(pb.hiringLabels.every((l) => typeof l.description === 'string' && l.description.length > 0)).toBe(true);
    expect(pb.weights).toHaveLength(6);
    expect(pb.compounds).toHaveLength(1);
  });
});
