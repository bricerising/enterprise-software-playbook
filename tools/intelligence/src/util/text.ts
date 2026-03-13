/** Known prompt injection marker patterns */
const INJECTION_PATTERNS = [
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|system\|>/i,
  /<\|user\|>/i,
  /<\|assistant\|>/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<\|endoftext\|>/i,
  /<<SYS>>/i,
  /<<\/SYS>>/i,
  /\bHuman:\s/,
  /\bAssistant:\s/,
  /\[SYSTEM\]/i,
];

/** Control characters (C0 except tab, C1, and other problematic chars) */
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Zero-width characters that can be used for steganographic injection */
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u200e\u200f\ufeff\u2060\u2061\u2062\u2063\u2064\u206a-\u206f]/g;

export interface SanitizeResult {
  text: string;
  flags: string[];
}

/**
 * Sanitize text for safe inclusion in JSON output and MCP framing.
 *
 * - Strips control characters (except \t, \n, \r which are normalized)
 * - Strips zero-width characters
 * - Escapes < > to prevent prompt delimiter confusion
 * - Removes embedded newlines (MCP framing safety)
 * - Truncates to maxLength
 * - Detects prompt injection markers
 */
export function sanitizeSnippet(
  input: string | null | undefined,
  opts: { maxLength?: number; removeNewlines?: boolean } = {},
): SanitizeResult {
  if (input == null) return { text: '', flags: [] };

  const maxLength = opts.maxLength ?? 500;
  const removeNewlines = opts.removeNewlines ?? true;
  const flags: string[] = [];

  let text = input;

  // Check for injection markers before sanitization
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      flags.push('injection_markers');
      break;
    }
  }

  // Strip control characters
  text = text.replace(CONTROL_CHARS_RE, '');

  // Strip zero-width characters
  text = text.replace(ZERO_WIDTH_RE, '');

  // Normalize/remove newlines for MCP framing safety
  if (removeNewlines) {
    text = text.replace(/[\r\n]+/g, ' ');
  }

  // Collapse multiple spaces
  text = text.replace(/ {2,}/g, ' ').trim();

  // Escape < > to prevent prompt delimiter confusion
  text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Truncate
  if (text.length > maxLength) {
    text = text.slice(0, maxLength - 3) + '...';
    flags.push('truncated');
  }

  return { text, flags };
}

/** Check if text contains prompt injection markers */
export function hasInjectionMarkers(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}
