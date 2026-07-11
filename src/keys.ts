import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ResolvedKey {
  key: string;
  source: 'env' | '.env';
}

/**
 * Extract the ANTHROPIC_API_KEY value from .env file content. Only this one
 * variable is read — deliberately not a general dotenv: no other variables
 * are parsed or injected. Comment lines are skipped, surrounding whitespace
 * is tolerated, and one layer of matching single/double quotes is stripped.
 * An empty value counts as missing (null).
 */
function parseEnvFile(content: string): string | null {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const match = line.match(/^ANTHROPIC_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Resolve the Anthropic API key: ANTHROPIC_API_KEY env var first, then a
 * gitignored ./.env in cwd. Returns null when neither yields a non-empty
 * value, so callers fail closed before any network call.
 */
export function resolveApiKey(cwd: string = process.cwd()): ResolvedKey | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv) {
    return { key: fromEnv, source: 'env' };
  }
  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    const value = parseEnvFile(readFileSync(envPath, 'utf8'));
    if (value) {
      return { key: value, source: '.env' };
    }
  }
  return null;
}
