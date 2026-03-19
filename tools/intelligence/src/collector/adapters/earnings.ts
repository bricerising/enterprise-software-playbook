import type { SourceType } from '../../types.js';
import type { RawEvent, Checkpoint, SourceAdapter } from './types.js';

/** Curated roster of major tech companies: ticker → CIK (zero-padded to 10 digits) */
const TECH_ROSTER = new Map<string, string>([
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
]);

interface EarningsAdapterOptions {
  name: string;
  /** Subset of built-in roster tickers to track */
  tickers?: string[];
  /** Form types to filter (default: ['10-K', '10-Q']) */
  form_types?: string[];
  /** Email for SEC User-Agent header */
  edgar_contact: string;
  /** Max requests per second (default 2, max 10) */
  edgar_max_rps?: number;
}

/** Parallel-array shape used by both recent filings and archive files */
interface FilingArrays {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  form: string[];
  primaryDocument: string[];
}

/** Shape of the SEC EDGAR company submissions JSON response */
interface SubmissionsResponse {
  cik: string;
  name: string;
  tickers: string[];
  filings: {
    recent: FilingArrays;
    /** Older filing archives — each entry points to a separate JSON file */
    files: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default timeout for SEC EDGAR requests (30 seconds). */
const EDGAR_FETCH_TIMEOUT_MS = 30_000;

export class EarningsAdapter implements SourceAdapter {
  readonly source: SourceType = 'earnings';
  readonly feedName: string;

  private readonly edgarContact: string;
  private readonly formTypes: Set<string>;
  private readonly requestDelayMs: number;
  private readonly activeRoster: Map<string, string>;

  constructor(opts: EarningsAdapterOptions) {
    this.feedName = opts.name;
    this.edgarContact = opts.edgar_contact;
    this.formTypes = new Set(opts.form_types ?? ['10-K', '10-Q']);

    const maxRps = Math.min(opts.edgar_max_rps ?? 2, 10);
    this.requestDelayMs = Math.ceil(1000 / maxRps);

    // Filter roster to requested tickers, or use full roster
    if (opts.tickers && opts.tickers.length > 0) {
      this.activeRoster = new Map<string, string>();
      for (const ticker of opts.tickers) {
        const upper = ticker.toUpperCase();
        const cik = TECH_ROSTER.get(upper);
        if (cik) {
          this.activeRoster.set(upper, cik);
        }
      }
    } else {
      this.activeRoster = new Map(TECH_ROSTER);
    }
  }

  private getUserAgent(): string {
    return `intel-collector/0.1.0 (${this.edgarContact})`;
  }

  /**
   * Build the filing document URL on SEC.gov.
   * Accession numbers have dashes (e.g. "0001234567-24-012345") but the
   * Archives path uses them without dashes as a directory name.
   */
  private buildFilingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
    const accessionDir = accessionNumber.replace(/-/g, '');
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionDir}/${primaryDocument}`;
  }

  /**
   * Yield events from a set of parallel filing arrays.
   */
  private *yieldFilings(
    arrays: FilingArrays,
    ticker: string,
    cik: string,
    companyName: string,
    cursorDate: string | null,
  ): Generator<RawEvent> {
    const len = arrays.accessionNumber.length;
    for (let i = 0; i < len; i++) {
      const form = arrays.form[i];
      const filingDate = arrays.filingDate[i];
      const accessionNumber = arrays.accessionNumber[i];
      const reportDate = arrays.reportDate[i];
      const primaryDocument = arrays.primaryDocument[i];

      // Filter by form type
      if (!this.formTypes.has(form)) continue;

      // Skip filings at or before checkpoint
      if (cursorDate && filingDate <= cursorDate) continue;

      yield {
        event_id: `earnings:${ticker}:${accessionNumber}`,
        source: 'earnings',
        feed: this.feedName,
        url: this.buildFilingUrl(cik, accessionNumber, primaryDocument),
        title: `${ticker} ${form} — Period ending ${reportDate}`,
        content: `${ticker} ${form} filing for period ending ${reportDate}`,
        author: companyName,
        published_at: filingDate,
        tags: [ticker, form],
        score: 0,
        comments: 0,
        source_meta: {
          ticker,
          cik,
          form_type: form,
          report_date: reportDate,
          filing_date: filingDate,
          company_name: companyName,
        },
      };
    }
  }

  async *fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent> {
    const cursorDate = checkpoint?.cursor ?? null;
    let isFirst = true;

    for (const [ticker, cik] of this.activeRoster) {
      // Rate-limit between company requests
      if (!isFirst) {
        await delay(this.requestDelayMs);
      }
      isFirst = false;

      let data: SubmissionsResponse;
      try {
        const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
        const ac = AbortSignal.timeout(EDGAR_FETCH_TIMEOUT_MS);
        const res = await globalThis.fetch(url, {
          headers: {
            'User-Agent': this.getUserAgent(),
            Accept: 'application/json',
          },
          signal: ac,
        });

        if (!res.ok) {
          console.error(
            `[intel] earnings: HTTP ${res.status} for ${ticker} (CIK ${cik})`,
          );
          continue;
        }

        data = (await res.json()) as SubmissionsResponse;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[intel] earnings: fetch failed for ${ticker}: ${message}`);
        continue;
      }

      const companyName = data.name;

      // Yield from recent filings
      yield* this.yieldFilings(data.filings.recent, ticker, cik, companyName, cursorDate);

      // Fetch and yield from historical archive files
      const archiveFiles = data.filings.files ?? [];
      for (const archive of archiveFiles) {
        // Skip archives entirely if all filings are before the checkpoint
        if (cursorDate && archive.filingTo <= cursorDate) continue;

        await delay(this.requestDelayMs);

        try {
          const archiveUrl = `https://data.sec.gov/submissions/${archive.name}`;
          const archiveAc = AbortSignal.timeout(EDGAR_FETCH_TIMEOUT_MS);
          const archiveRes = await globalThis.fetch(archiveUrl, {
            headers: {
              'User-Agent': this.getUserAgent(),
              Accept: 'application/json',
            },
            signal: archiveAc,
          });

          if (!archiveRes.ok) {
            console.error(
              `[intel] earnings: HTTP ${archiveRes.status} fetching archive ${archive.name} for ${ticker}`,
            );
            continue;
          }

          const archiveData = (await archiveRes.json()) as FilingArrays;
          yield* this.yieldFilings(archiveData, ticker, cik, companyName, cursorDate);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[intel] earnings: archive fetch failed for ${ticker} (${archive.name}): ${message}`);
          continue;
        }
      }
    }
  }
}
