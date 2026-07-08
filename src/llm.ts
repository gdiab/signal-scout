import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

/** Model id used for hiring-posting classification. */
export const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';

/** Model id used for brief generation only. */
export const BRIEF_MODEL = 'claude-sonnet-5';

export interface LlmClient {
  classify(input: { id: string; prompt: string }): Promise<string>;
  generate(input: { id: string; prompt: string; maxTokens?: number }): Promise<string>;
}

/**
 * Concatenates every text block in a Messages API response, ignoring any
 * other block types. Models with thinking enabled by default (claude-sonnet-5
 * runs adaptive thinking when the `thinking` param is omitted) put a
 * `thinking` block FIRST in `content`, so reading `content[0].text` returns
 * nothing — the live run that surfaced this produced 10 briefs with empty
 * text. Trimmed, so callers get '' (not whitespace) when no text came back.
 */
export function extractText(blocks: Array<{ type: string; text?: string; thinking?: string }>): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
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
      return extractText(response.content);
    },

    async generate({ prompt, maxTokens }): Promise<string> {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY environment variable is not set; liveLlm requires it to call the Anthropic API.',
        );
      }
      if (!client) {
        client = new Anthropic();
      }
      // Thinking is explicitly disabled: claude-sonnet-5 (the brief model)
      // runs adaptive thinking when the param is omitted, and thinking tokens
      // count against max_tokens — a 700-token brief budget could be spent
      // mostly on thinking, truncating or emptying the visible text.
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens ?? 1024,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      });
      return extractText(response.content);
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

    async generate({ id }): Promise<string> {
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
