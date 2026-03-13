import { describe, it, expect } from 'vitest';
import { ControlClient } from '../src/control/channel.js';

describe('ControlClient', () => {
  it('reports daemon not running when no PID file', () => {
    const { running } = ControlClient.isDaemonRunning();
    // In test environment, no daemon is running
    expect(running).toBe(false);
  });

  it('returns error when sending command with no daemon', async () => {
    const result = await ControlClient.sendCommand('checkpoint');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not running');
  });
});
