import type { SourceType } from '../../types.js';
import type { RawEvent, Checkpoint, SourceAdapter } from './types.js';

const EDGAR_RSS_BASE = 'https://www.sec.gov/cgi-bin/browse-edgar';

/** Ticker → CIK mapping. Shared with earnings adapter roster. */
const TICKER_TO_CIK = new Map<string, string>([
  ['AAPL', '0000320193'],
  ['MSFT', '0000789019'],
  ['GOOG', '0001652044'],
  ['AMZN', '0001018724'],
  ['META', '0001326801'],
  ['NVDA', '0001045810'],
  ['TSLA', '0001318605'],
  ['NFLX', '0001065280'],
  ['AMD', '0000002488'],
  ['INTC', '0000050863'],
  ['CRM', '0001108524'],
  ['ADBE', '0000796343'],
  ['AVGO', '0001649338'],
  ['SNOW', '0001640147'],
  ['DDOG', '0001561550'],
  ['CRWD', '0001535527'],
  ['NET', '0001477333'],
  ['PLTR', '0001321655'],
  ['MDB', '0001441816'],
  ['NOW', '0001373715'],
  // Semiconductors
  ['MRVL', '0001058057'],
  ['QCOM', '0000804328'],
  // Payments / FinTech
  ['SQ', '0001512673'],
  ['FI', '0000798354'],
  ['GPN', '0001123360'],
  ['TOST', '0001650164'],
  ['PYPL', '0001633917'],
  ['SHOP', '0001594805'],
  ['FIS', '0001136893'],
  ['VYX', '0001131554'],
  ['MQ', '0001522540'],
  ['WEX', '0001309108'],
  ['ACIW', '0000935036'],
  // SaaS
  ['WDAY', '0001327811'],
]);

/** Returns true if the string looks like a 10-digit zero-padded CIK */
function isCik(value: string): boolean {
  return /^\d{10}$/.test(value);
}

interface EdgarAdapterOptions {
  name: string;
  /** Email to include in User-Agent per SEC EDGAR fair access policy */
  edgar_contact: string;
  /** Form types to filter (e.g. ['8-K', '10-K', '10-Q']) */
  form_types?: string[];
  /** Max requests per second (default 2, max 10) */
  edgar_max_rps?: number;
  /** Ticker symbols or CIK numbers to filter by */
  entities?: string[];
}

interface EdgarEntry {
  title: string;
  link: string;
  summary: string;
  updated: string;
  category: string;
  accession_number: string;
  form_type: string;
  cik: string;
  company_name: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse accession number from an EDGAR URL or entry content.
 * Accession numbers have the format: 0001234567-23-012345
 */
function parseAccessionNumber(text: string): string | null {
  const match = text.match(/(\d{10}-\d{2}-\d{6})/);
  return match ? match[1] : null;
}

/**
 * Parse form type from an EDGAR entry title.
 * Titles are typically like: "8-K - Company Name (0001234567) (Filer)"
 */
function parseFormType(title: string): string {
  const match = title.match(/^(\S+)\s*-/);
  return match ? match[1] : title.split(/\s/)[0] ?? '';
}

/**
 * Parse CIK from an EDGAR entry title or link.
 * CIK appears in parens: "(0001234567)"
 */
function parseCik(text: string): string | null {
  const match = text.match(/\((\d{10})\)/);
  return match ? match[1] : null;
}

/**
 * Parse company name from an EDGAR entry title.
 * Title format: "FORM_TYPE - Company Name (CIK) (Filer)"
 */
function parseCompanyName(title: string): string {
  const match = title.match(/^\S+\s*-\s*(.+?)\s*\(\d{10}\)/);
  return match ? match[1].trim() : '';
}

export class EdgarAdapter implements SourceAdapter {
  readonly source: SourceType = 'edgar';
  readonly feedName: string;

  private readonly edgarContact: string;
  private readonly formTypes: Set<string>;
  private readonly requestDelayMs: number;
  private readonly entities: Set<string> | null;

  constructor(opts: EdgarAdapterOptions) {
    this.feedName = opts.name;
    this.edgarContact = opts.edgar_contact;
    this.formTypes = new Set(opts.form_types ?? ['8-K', '10-K', '10-Q']);

    const maxRps = Math.min(opts.edgar_max_rps ?? 2, 10);
    this.requestDelayMs = Math.ceil(1000 / maxRps);

    // Resolve entities: accept both ticker symbols and raw CIK numbers.
    // Ticker symbols are looked up in the built-in roster.
    if (opts.entities && opts.entities.length > 0) {
      const resolved = new Set<string>();
      for (const entity of opts.entities) {
        if (isCik(entity)) {
          resolved.add(entity);
        } else {
          const cik = TICKER_TO_CIK.get(entity.toUpperCase());
          if (cik) {
            resolved.add(cik);
          } else {
            console.error(
              `[intel] edgar: ticker ${entity.toUpperCase()} not in built-in roster, skipping — use 10-digit CIK or add mapping`,
            );
          }
        }
      }
      this.entities = resolved.size > 0 ? resolved : null;
    } else {
      this.entities = null;
    }
  }

  private buildFeedUrl(formType: string, cik?: string): string {
    const params = new URLSearchParams({
      action: 'getcompany',
      type: formType,
      dateb: '',
      owner: 'include',
      count: '40',
      search_text: '',
      output: 'atom',
    });

    if (cik) {
      params.set('CIK', cik);
    }

    return `${EDGAR_RSS_BASE}?${params.toString()}`;
  }

  private getUserAgent(): string {
    return `intel-collector/0.1.0 (${this.edgarContact})`;
  }

  async *fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent> {
    const checkpointAccession = checkpoint?.cursor ?? null;
    const seenAccessions = new Set<string>();

    // SEC EDGAR does not support comma-separated form types in a single
    // request, so iterate over each (formType, CIK) pair individually.
    const ciks = this.entities ? [...this.entities] : [undefined];
    const formTypes = [...this.formTypes];

    for (const formType of formTypes) {
    for (const cik of ciks) {
      const feedUrl = this.buildFeedUrl(formType, cik);

      let responseText: string;
      try {
        const res = await globalThis.fetch(feedUrl, {
          headers: {
            'User-Agent': this.getUserAgent(),
            Accept: 'application/atom+xml, application/xml, text/xml',
          },
        });

        if (!res.ok) {
          console.error(
            `[intel] edgar: HTTP ${res.status} from ${feedUrl}`,
          );
          await delay(this.requestDelayMs);
          continue;
        }

        responseText = await res.text();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[intel] edgar: fetch failed for ${feedUrl}: ${message}`);
        await delay(this.requestDelayMs);
        continue;
      }

      // Rate-limit between requests
      await delay(this.requestDelayMs);

      // Parse the Atom XML response
      const entries = this.parseAtomEntries(responseText);

      for (const entry of entries) {
        // Skip if we have already seen this accession number
        if (seenAccessions.has(entry.accession_number)) continue;
        seenAccessions.add(entry.accession_number);

        // Skip entries older than checkpoint
        if (checkpointAccession && entry.accession_number <= checkpointAccession) {
          continue;
        }

        // Filter by form type
        if (this.formTypes.size > 0 && !this.formTypes.has(entry.form_type)) {
          continue;
        }

        // Filter by entity CIK if configured
        if (this.entities && entry.cik && !this.entities.has(entry.cik)) {
          continue;
        }

        const rawEvent: RawEvent = {
          event_id: `edgar:${entry.accession_number}`,
          source: 'edgar',
          feed: this.feedName,
          url: entry.link,
          title: entry.title,
          content: entry.summary || null,
          author: entry.company_name || null,
          published_at: entry.updated ? new Date(entry.updated).toISOString() : null,
          tags: [entry.form_type, entry.category].filter(Boolean),
          score: 0,
          comments: 0,
          source_meta: {
            accession_number: entry.accession_number,
            form_type: entry.form_type,
            cik: entry.cik,
            company_name: entry.company_name,
          },
        };

        yield rawEvent;
      }
    }
    }
  }

  /**
   * Parse Atom XML entries from EDGAR response.
   * Uses basic string parsing to avoid requiring an XML parser dependency.
   */
  private parseAtomEntries(xml: string): EdgarEntry[] {
    const entries: EdgarEntry[] = [];

    // Split on <entry> tags
    const entryBlocks = xml.split(/<entry>/i).slice(1);

    for (const block of entryBlocks) {
      const endIdx = block.indexOf('</entry>');
      const entryXml = endIdx >= 0 ? block.slice(0, endIdx) : block;

      const title = this.extractTag(entryXml, 'title') ?? '';
      const link = this.extractAttr(entryXml, 'link', 'href') ?? '';
      const summary = this.extractTag(entryXml, 'summary') ?? '';
      const updated = this.extractTag(entryXml, 'updated') ?? '';
      const category = this.extractAttr(entryXml, 'category', 'term') ?? '';

      // Parse structured data from entry content
      const accessionNumber = parseAccessionNumber(link) ?? parseAccessionNumber(title) ?? '';
      if (!accessionNumber) continue;

      const formType = parseFormType(title);
      const cikValue = parseCik(title);
      const companyName = parseCompanyName(title);

      entries.push({
        title,
        link,
        summary,
        updated,
        category,
        accession_number: accessionNumber,
        form_type: formType,
        cik: cikValue ?? '',
        company_name: companyName,
      });
    }

    return entries;
  }

  /** Extract text content of a simple XML tag */
  private extractTag(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }

  /** Extract an attribute value from a self-closing or opening XML tag */
  private extractAttr(xml: string, tag: string, attr: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
    const match = xml.match(regex);
    return match ? match[1] : null;
  }
}
