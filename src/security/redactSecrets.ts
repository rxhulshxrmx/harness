// Regex-based secret redaction applied to every tool result before it is
// persisted to .couplet/sessions/*.jsonl or shown in the webview. Patterns
// ported from codex's secret sanitizer (openai/codex, secrets/src/sanitizer.rs).
// Each pattern redacts only the secret value, preserving any surrounding key
// name/delimiter so the redacted text still reads sensibly.

const PATTERNS: RegExp[] = [
  // OpenAI-style API keys, e.g. sk-abcdEFGH12345678901234
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
];

// Generic `key: value` / `key=value` assignment for api_key/token/secret/password —
// captures the key/delimiter so they can be preserved in the replacement.
const ASSIGNMENT_PATTERN = /\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)(['"]?)(\S{8,})\3/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(ASSIGNMENT_PATTERN, (_match, key, sep, quote) => `${key}${sep}${quote}[REDACTED]${quote}`);
  return out;
}
