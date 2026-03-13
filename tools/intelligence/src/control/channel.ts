import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

export interface ControlRequest {
  command: string;
  args?: Record<string, unknown>;
}

export interface ControlResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type CommandHandler = (
  db: Database.Database,
  args: Record<string, unknown>,
) => ControlResponse;

function getSocketDir(): string {
  const xdgRuntime = process.env['XDG_RUNTIME_DIR'];
  if (xdgRuntime) {
    const dir = join(xdgRuntime, 'intel');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return tmpdir();
}

function getSocketPath(pid?: number): string {
  const dir = getSocketDir();
  if (process.env['XDG_RUNTIME_DIR']) {
    return join(dir, 'control.sock');
  }
  return join(dir, `intel-ctrl-${pid ?? process.pid}.sock`);
}

function getPidFilePath(): string {
  const dir = getSocketDir();
  return join(dir, 'intel.pid');
}

export class ControlServer {
  private server: Server | null = null;
  private handlers = new Map<string, CommandHandler>();
  private socketPath: string;

  constructor(private db: Database.Database) {
    this.socketPath = getSocketPath();
  }

  registerHandler(command: string, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket
      if (existsSync(this.socketPath)) {
        try {
          unlinkSync(this.socketPath);
        } catch {
          // ignore
        }
      }

      this.server = createServer((socket: Socket) => {
        let buffer = '';
        socket.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const req = JSON.parse(line) as ControlRequest;
              const response = this.handleRequest(req);
              socket.write(JSON.stringify(response) + '\n');
            } catch (err) {
              const errResp: ControlResponse = {
                ok: false,
                error: err instanceof Error ? err.message : 'Unknown error',
              };
              socket.write(JSON.stringify(errResp) + '\n');
            }
          }
        });
      });

      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        // Write PID file
        const pidPath = getPidFilePath();
        writeFileSync(pidPath, String(process.pid));
        resolve();
      });
    });
  }

  private handleRequest(req: ControlRequest): ControlResponse {
    const handler = this.handlers.get(req.command);
    if (!handler) {
      return { ok: false, error: `Unknown command: ${req.command}` };
    }
    try {
      return handler(this.db, req.args ?? {});
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try {
      unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
    try {
      unlinkSync(getPidFilePath());
    } catch {
      // ignore
    }
  }
}

export class ControlClient {
  static isDaemonRunning(): { running: boolean; pid?: number } {
    const pidPath = getPidFilePath();
    if (!existsSync(pidPath)) {
      return { running: false };
    }
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      // Check if process exists
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      return { running: false };
    }
  }

  static async sendCommand(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<ControlResponse> {
    const { running, pid } = ControlClient.isDaemonRunning();
    if (!running) {
      return { ok: false, error: 'Collector daemon is not running' };
    }

    const socketPath = getSocketPath(pid);
    if (!existsSync(socketPath)) {
      // Try default path
      const defaultPath = getSocketPath();
      if (!existsSync(defaultPath)) {
        return { ok: false, error: 'Control socket not found' };
      }
      return ControlClient.sendToSocket(defaultPath, command, args);
    }

    return ControlClient.sendToSocket(socketPath, command, args);
  }

  private static sendToSocket(
    socketPath: string,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = '';

      socket.on('connect', () => {
        const req: ControlRequest = { command, args };
        socket.write(JSON.stringify(req) + '\n');
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          const line = buffer.slice(0, idx);
          try {
            resolve(JSON.parse(line) as ControlResponse);
          } catch {
            resolve({ ok: false, error: 'Invalid response from daemon' });
          }
          socket.destroy();
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });

      socket.setTimeout(10000, () => {
        socket.destroy();
        resolve({ ok: false, error: 'Control channel timeout' });
      });
    });
  }
}
