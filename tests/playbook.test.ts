import { describe, it, expect } from 'vitest';
import { loadPlaybook } from '../src/playbook.js';

describe('loadPlaybook', () => {
  it('loads the ai-startups playbook with 6 weights and 1 compound', () => {
    const pb = loadPlaybook('playbooks/ai-startups.json');
    expect(pb.name).toBe('ai-startups');
    expect(pb.weights).toHaveLength(6);
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
});
