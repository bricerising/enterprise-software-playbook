/** Tracking parameters to strip from URLs */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'source',
  'via',
]);

/**
 * Normalize a URL for cross-source dedup:
 * 1. Strip tracking parameters (utm_*, ref, source, via)
 * 2. Remove trailing slashes
 * 3. Remove fragment
 * 4. Lowercase hostname
 */
export function canonicalizeUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);

    // Lowercase hostname
    url.hostname = url.hostname.toLowerCase();

    // Remove fragment
    url.hash = '';

    // Strip tracking parameters
    for (const param of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        url.searchParams.delete(param);
      }
    }

    // Sort remaining params for consistency
    url.searchParams.sort();

    let result = url.toString();

    // Remove trailing slash (but not root path)
    if (result.endsWith('/') && url.pathname !== '/') {
      result = result.slice(0, -1);
    }

    return result;
  } catch {
    // Invalid URL — return null rather than throwing
    return null;
  }
}
