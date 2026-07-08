import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createMock = vi.fn(async (_request: Record<string, unknown>) => ({
  content: [{ type: 'text', text: 'ok' }],
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: createMock };
  }
  return { default: FakeAnthropic };
});

describe('liveLlm generate()', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockClear();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('sends thinking: { type: "disabled" } on every generate() call', async () => {
    const { liveLlm } = await import('../src/llm.js');
    const llm = liveLlm('claude-sonnet-5');

    await llm.generate({ id: 'brief:acme', prompt: 'write a brief', maxTokens: 1100 });

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0][0];
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.model).toBe('claude-sonnet-5');
    expect(request.max_tokens).toBe(1100);
  });
});
