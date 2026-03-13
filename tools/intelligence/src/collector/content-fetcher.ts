import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { ContentFlag } from '../types.js';

/** Minimum content length to consider extraction successful */
const MIN_CONTENT_LENGTH = 100;

/** Default maximum content length before truncation */
const DEFAULT_MAX_CONTENT_LENGTH = 50_000;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 10_000;

/** Default rate limit: 1 request per second per hostname */
const PER_DOMAIN_DELAY_MS = 1_000;

interface ContentFetcherOptions {
  /** Domains from which content fetching is blocked */
  blocked_domains?: string[];
  /** Maximum content length (chars) before truncation */
  max_content_length?: number;
}

interface FetchResult {
  content: string | null;
  flags: ContentFlag[];
}

/** Track last request time per hostname for rate limiting */
const domainLastRequest = new Map<string, number>();

/**
 * Wait until at least PER_DOMAIN_DELAY_MS has elapsed since the last
 * request to the given hostname.
 */
async function rateLimitDomain(hostname: string): Promise<void> {
  const lastTime = domainLastRequest.get(hostname);
  if (lastTime != null) {
    const elapsed = Date.now() - lastTime;
    if (elapsed < PER_DOMAIN_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, PER_DOMAIN_DELAY_MS - elapsed));
    }
  }
  domainLastRequest.set(hostname, Date.now());
}

export class ContentFetcher {
  private readonly blockedDomains: Set<string>;
  private readonly maxContentLength: number;

  constructor(opts?: ContentFetcherOptions) {
    this.blockedDomains = new Set(
      (opts?.blocked_domains ?? []).map((d) => d.toLowerCase()),
    );
    this.maxContentLength = opts?.max_content_length ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * Fetch a URL, extract readable content with Readability,
   * and return sanitized text with content flags.
   */
  async fetch(url: string): Promise<FetchResult> {
    const flags: ContentFlag[] = [];

    // Check if domain is blocked
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      flags.push('fetch_failed');
      return { content: null, flags };
    }

    if (this.isDomainBlocked(hostname)) {
      flags.push('blocked_domain');
      return { content: null, flags };
    }

    // Per-domain rate limiting
    await rateLimitDomain(hostname);

    // Fetch with timeout
    let html: string;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; intel-collector/0.1.0; +https://github.com/enterprise-playbook)',
            Accept: 'text/html, application/xhtml+xml',
          },
          redirect: 'follow',
        });

        if (!res.ok) {
          flags.push('fetch_failed');
          return { content: null, flags };
        }

        html = await res.text();
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: unknown) {
      // Timeout, network error, or aborted
      flags.push('fetch_failed');
      return { content: null, flags };
    }

    // Extract readable content with Readability
    let extractedText: string | null = null;
    try {
      const dom = new JSDOM(html, {
        url,
        runScripts: 'outside-only',
      });

      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article?.textContent) {
        extractedText = article.textContent.trim();
        flags.push('extracted');
      }

      // Clean up JSDOM to free memory
      dom.window.close();
    } catch {
      // Readability/JSDOM failure — graceful fallback
      flags.push('fetch_failed');
      return { content: null, flags };
    }

    if (!extractedText || extractedText.length < MIN_CONTENT_LENGTH) {
      // Content too short to be meaningful
      return { content: null, flags };
    }

    // Truncate if over max length
    if (extractedText.length > this.maxContentLength) {
      extractedText = extractedText.slice(0, this.maxContentLength);
      flags.push('truncated');
    }

    return { content: extractedText, flags };
  }

  /**
   * Check whether a hostname is blocked, including parent domain matching.
   * For example, blocking "example.com" also blocks "sub.example.com".
   */
  private isDomainBlocked(hostname: string): boolean {
    if (this.blockedDomains.has(hostname)) return true;

    // Check parent domains
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      if (this.blockedDomains.has(parent)) return true;
    }

    return false;
  }
}

/** Shared instance cache */
let sharedFetcher: ContentFetcher | null = null;

/** Convenience function matching collector/index.ts import */
export async function fetchContent(
  url: string,
  opts?: {
    timeoutMs?: number;
    maxLength?: number;
    blockedDomains?: string[];
  },
): Promise<{ content: string | null; flags: ContentFlag[] }> {
  if (
    !sharedFetcher ||
    opts?.blockedDomains
  ) {
    sharedFetcher = new ContentFetcher({
      blocked_domains: opts?.blockedDomains,
      max_content_length: opts?.maxLength,
    });
  }
  return sharedFetcher.fetch(url);
}
