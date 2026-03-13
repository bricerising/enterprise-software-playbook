import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadConfig('/nonexistent/config.yaml');
    expect(config.collector.poll_interval_seconds).toBe(300);
    expect(config.collector.batch_size).toBe(100);
    expect(config.collector.edgar_max_rps).toBe(2);
    expect(config.output.format).toBe('json');
  });

  it('loads example config', () => {
    const config = loadConfig(
      new URL('../config/feeds.example.yaml', import.meta.url).pathname,
    );
    expect(config.feeds.length).toBeGreaterThan(0);
    expect(config.collector.edgar_contact).toBe('user@example.com');
  });
});
