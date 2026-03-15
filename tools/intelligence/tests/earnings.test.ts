import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EarningsAdapter } from '../src/collector/adapters/earnings.js';
import type { RawEvent } from '../src/collector/adapters/types.js';

/** Minimal SEC submissions JSON fixture */
function makeSubmissionsFixture(overrides?: {
  name?: string;
  accessionNumbers?: string[];
  filingDates?: string[];
  reportDates?: string[];
  forms?: string[];
  primaryDocuments?: string[];
}) {
  return {
    cik: '0001045810',
    name: overrides?.name ?? 'NVIDIA CORP',
    tickers: ['NVDA'],
    filings: {
      recent: {
        accessionNumber: overrides?.accessionNumbers ?? [
          '0001045810-24-000100',
          '0001045810-24-000080',
          '0001045810-24-000060',
        ],
        filingDate: overrides?.filingDates ?? [
          '2024-11-20',
          '2024-08-28',
          '2024-05-22',
        ],
        reportDate: overrides?.reportDates ?? [
          '2024-10-27',
          '2024-07-28',
          '2024-04-28',
        ],
        form: overrides?.forms ?? ['10-Q', '10-Q', '10-K'],
        primaryDocument: overrides?.primaryDocuments ?? [
          'nvda-20241027.htm',
          'nvda-20240728.htm',
          'nvda-20240428.htm',
        ],
      },
    },
  };
}

function mockFetchResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

async function collectEvents(adapter: EarningsAdapter, checkpoint: { cursor: string; updated_at: string } | null = null): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  for await (const event of adapter.fetch(checkpoint)) {
    events.push(event);
  }
  return events;
}

describe('EarningsAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses submissions JSON into correct events', async () => {
    const fixture = makeSubmissionsFixture();
    fetchSpy.mockImplementation(() => mockFetchResponse(fixture));

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['NVDA'],
      edgar_contact: 'test@example.com',
    });

    const events = await collectEvents(adapter);

    expect(events).toHaveLength(3);

    // Verify first event structure
    const first = events[0];
    expect(first.event_id).toBe('earnings:NVDA:0001045810-24-000100');
    expect(first.source).toBe('earnings');
    expect(first.feed).toBe('test');
    expect(first.title).toBe('NVDA 10-Q — Period ending 2024-10-27');
    expect(first.author).toBe('NVIDIA CORP');
    expect(first.published_at).toBe('2024-11-20');
    expect(first.tags).toEqual(['NVDA', '10-Q']);
    expect(first.content).toBe('NVDA 10-Q filing for period ending 2024-10-27');
    expect(first.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/0001045810/000104581024000100/nvda-20241027.htm',
    );
    expect(first.source_meta).toEqual({
      ticker: 'NVDA',
      cik: '0001045810',
      form_type: '10-Q',
      report_date: '2024-10-27',
      filing_date: '2024-11-20',
      company_name: 'NVIDIA CORP',
    });

    // Verify last event (10-K)
    const last = events[2];
    expect(last.event_id).toBe('earnings:NVDA:0001045810-24-000060');
    expect(last.title).toBe('NVDA 10-K — Period ending 2024-04-28');
    expect(last.tags).toEqual(['NVDA', '10-K']);
  });

  it('respects checkpoint — only yields filings after cursor date', async () => {
    const fixture = makeSubmissionsFixture();
    fetchSpy.mockImplementation(() => mockFetchResponse(fixture));

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['NVDA'],
      edgar_contact: 'test@example.com',
    });

    // Set checkpoint to middle filing date — should skip that one and older
    const events = await collectEvents(adapter, {
      cursor: '2024-08-28',
      updated_at: '2024-08-28T00:00:00Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0].published_at).toBe('2024-11-20');
  });

  it('filters by form_type — excludes unconfigured types', async () => {
    const fixture = makeSubmissionsFixture({
      accessionNumbers: ['0001045810-24-000100', '0001045810-24-000080', '0001045810-24-000060'],
      filingDates: ['2024-11-20', '2024-08-28', '2024-05-22'],
      reportDates: ['2024-10-27', '2024-07-28', '2024-04-28'],
      forms: ['10-Q', '8-K', '10-K'],
      primaryDocuments: ['nvda-10q.htm', 'nvda-8k.htm', 'nvda-10k.htm'],
    });
    fetchSpy.mockImplementation(() => mockFetchResponse(fixture));

    // Default form_types is ['10-K', '10-Q'] — 8-K should be excluded
    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['NVDA'],
      edgar_contact: 'test@example.com',
    });

    const events = await collectEvents(adapter);

    expect(events).toHaveLength(2);
    const forms = events.map((e) => e.tags[1]);
    expect(forms).toEqual(['10-Q', '10-K']);
    expect(forms).not.toContain('8-K');
  });

  it('rate limits between company fetches', async () => {
    const fixture = makeSubmissionsFixture();
    fetchSpy.mockImplementation(() => mockFetchResponse(fixture));

    const delaySpy = vi.spyOn(globalThis, 'setTimeout');

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['NVDA', 'AAPL'],
      edgar_contact: 'test@example.com',
      edgar_max_rps: 2,
    });

    await collectEvents(adapter);

    // fetch should have been called twice (once per ticker)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // setTimeout should have been called at least once for rate limiting between companies
    expect(delaySpy).toHaveBeenCalled();

    delaySpy.mockRestore();
  });

  it('handles API errors gracefully — continues to next company', async () => {
    const fixture = makeSubmissionsFixture({ name: 'APPLE INC' });

    // First call (AAPL) returns error, second (NVDA) succeeds
    // Note: Map iteration order depends on insertion order in the filtered roster.
    // When tickers are ['AAPL', 'NVDA'], AAPL is inserted first.
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return mockFetchResponse({}, 429);
      }
      return mockFetchResponse(fixture);
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['AAPL', 'NVDA'],
      edgar_contact: 'test@example.com',
    });

    const events = await collectEvents(adapter);

    // Should still get events from the second company
    expect(events.length).toBeGreaterThan(0);
    // Should have logged an error for the first company
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 429'),
    );

    consoleSpy.mockRestore();
  });

  it('ticker filter restricts roster to specified tickers', async () => {
    const fixture = makeSubmissionsFixture();
    fetchSpy.mockImplementation(() => mockFetchResponse(fixture));

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['NVDA', 'AAPL'],
      edgar_contact: 'test@example.com',
    });

    await collectEvents(adapter);

    // Should only fetch for 2 companies
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Verify the URLs contain the correct CIKs
    const urls = fetchSpy.mock.calls.map((call) => call[0] as string);
    expect(urls).toContainEqual('https://data.sec.gov/submissions/CIK0001045810.json'); // NVDA
    expect(urls).toContainEqual('https://data.sec.gov/submissions/CIK0000320193.json'); // AAPL
  });

  it('handles fetch network errors gracefully', async () => {
    fetchSpy.mockRejectedValue(new Error('Network timeout'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['NVDA'],
      edgar_contact: 'test@example.com',
    });

    const events = await collectEvents(adapter);

    expect(events).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Network timeout'),
    );

    consoleSpy.mockRestore();
  });

  it('uses case-insensitive ticker matching', async () => {
    const fixture = makeSubmissionsFixture();
    fetchSpy.mockImplementation(() => mockFetchResponse(fixture));

    const adapter = new EarningsAdapter({
      name: 'test',
      tickers: ['nvda'],  // lowercase
      edgar_contact: 'test@example.com',
    });

    const events = await collectEvents(adapter);

    expect(events).toHaveLength(3);
    // Event IDs should use uppercase ticker
    expect(events[0].event_id).toContain('NVDA');
  });
});
