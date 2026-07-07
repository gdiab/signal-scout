import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

/** Model id used for hiring-posting classification. */
export const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';

export interface LlmClient {
  classify(input: { id: string; prompt: string }): Promise<string>;
}

/**
 * Live Anthropic-backed LlmClient. Reads ANTHROPIC_API_KEY from the
 * environment lazily — only when classify() is first called, never at
 * construction — so callers can build a client (e.g. to wire up a CLI)
 * without an API key present, and only fail if a live call is actually made.
 */
export function liveLlm(model: string): LlmClient {
  let client: Anthropic | undefined;

  return {
    async classify({ prompt }): Promise<string> {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY environment variable is not set; liveLlm requires it to call the Anthropic API.',
        );
      }
      if (!client) {
        client = new Anthropic();
      }
      const response = await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = response.content[0];
      const text = block && block.type === 'text' ? block.text : '';
      return text.trim();
    },
  };
}

/**
 * Recorded-fixture LlmClient: loads a JSON file mapping input.id -> response
 * string, once, lazily (not at construction time). Used to demo the pipeline
 * deterministically without an API key.
 */
export function fixtureLlm(path: string): LlmClient {
  let responses: Record<string, string> | undefined;

  return {
    async classify({ id }): Promise<string> {
      if (!responses) {
        responses = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
      }
      const response = responses[id];
      if (response === undefined) {
        throw new Error(`fixtureLlm: no recorded response for id "${id}" in ${path}`);
      }
      return response;
    },
  };
}
