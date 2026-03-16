import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import type { SourceType } from '../types.js';
import { openReader } from '../db.js';
import { searchEvents } from '../queries/search.js';
import { computeTrends } from '../queries/trends.js';
import { listEvents, getEvent } from '../queries/events.js';
import { querySources } from '../queries/sources.js';
import { queryTopics } from '../queries/topics.js';
import { queryStats } from '../queries/stats.js';
import { buildPack } from '../queries/pack.js';
import { computeForecast } from '../queries/forecast.js';
import { composeRiskIntelligence } from '../queries/risk-intelligence.js';
import type { ArchobsInput } from '../queries/risk-intelligence.js';
import { computeTrajectory } from '../queries/change-trajectory.js';
import type { TrajectoryInput } from '../queries/change-trajectory.js';
import { loadTopics, getLoadedTopics } from '../collector/topic-classifier.js';

const TOOL_DEFINITIONS = [
  {
    name: 'intel_trends',
    description: 'Get trending tech topics with scores from collected intelligence',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window: { type: 'string', description: 'Time window (e.g., "60m", "24h")', default: '60m' },
        top: { type: 'number', description: 'Number of top trends to return', default: 10 },
        since: { type: 'string', description: 'Override window start (e.g., "24h")' },
        dedup: { type: 'string', enum: ['canonical', 'none'], default: 'canonical' },
      },
    },
  },
  {
    name: 'intel_search',
    description: 'Full-text search across collected intelligence events',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (FTS5 syntax)' },
        source: { type: 'string', description: 'Filter by source type' },
        topic: { type: 'string', description: 'Filter by topic' },
        since: { type: 'string', description: 'Time bound (e.g., "7d")' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
      required: ['query'],
    },
  },
  {
    name: 'intel_events',
    description: 'Browse intelligence events by topic, source, or time',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Get a specific event by ID (full content)' },
        topic: { type: 'string', description: 'Filter by topic' },
        source: { type: 'string', description: 'Filter by source type' },
        since: { type: 'string', description: 'Time bound (e.g., "3d")' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
    },
  },
  {
    name: 'intel_sources',
    description: 'Check data source freshness and health',
    inputSchema: {
      type: 'object' as const,
      properties: {
        stale: { type: 'string', description: 'Only show sources stale for this duration (e.g., "30m")' },
      },
    },
  },
  {
    name: 'intel_topics',
    description: 'List configured intelligence topics',
    inputSchema: {
      type: 'object' as const,
      properties: {
        active: { type: 'boolean', description: 'Only topics with events in last 7d' },
        match: { type: 'string', description: 'Filter by keyword' },
      },
    },
  },
  {
    name: 'intel_stats',
    description: 'Database statistics and health overview',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'intel_pack',
    description: 'Bounded evidence bundle for agent synthesis (trends + events + source health)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Time window (e.g., "6h", "24h")', default: '6h' },
        top: { type: 'number', description: 'Number of trends', default: 10 },
        max_events: { type: 'number', description: 'Max events per trend', default: 5 },
      },
    },
  },
  {
    name: 'intel_forecast',
    description: 'Predict likely next developments using Bayesian scenario projection, exponential decay weighting, entropy scoring, CUSUM change-point detection, and HMM lifecycle classification',
    inputSchema: {
      type: 'object' as const,
      properties: {
        lag_window_days: { type: 'number', description: 'Max days between chain links (default: 7)' },
        min_support: { type: 'number', description: 'Min co-occurrences for valid chain (default: 2)' },
        top_scenarios: { type: 'number', description: 'Max scenarios to return (default: 10)' },
        dedup: { type: 'string', enum: ['canonical', 'none'], default: 'canonical' },
      },
    },
  },
  {
    name: 'intel_risk_overlay',
    description: 'Compose architecture observability metrics with forecast intelligence to surface compound risk signals',
    inputSchema: {
      type: 'object' as const,
      properties: {
        clusters: {
          type: 'array',
          description: 'Archobs cluster metrics (from archobs show clusters --format json)',
          items: { type: 'object' },
        },
        file_risks: {
          type: 'array',
          description: 'Archobs file risk metrics (from archobs show risks --format json)',
          items: { type: 'object' },
        },
        drift: {
          type: 'object',
          description: 'Most recent archobs drift entry (from archobs show drift --format json)',
        },
        import_specifiers: {
          type: 'array',
          description: 'External package import specifiers from the codebase (optional, improves topic matching)',
          items: { type: 'string' },
        },
      },
      required: ['clusters'],
    },
  },
  {
    name: 'intel_change_trajectory',
    description: 'Analyze recent development patterns from git history to surface where development momentum is concentrated and what areas are growing — structured data for predicting likely next features',
    inputSchema: {
      type: 'object' as const,
      properties: {
        commits: {
          type: 'array',
          description: 'Commit-level file changes. Each: {commit_sha, commit_ts (unix seconds), status (A/M/D), path}',
          items: { type: 'object' },
        },
        clusters: {
          type: 'array',
          description: 'Archobs cluster metrics (from archobs show clusters --format json)',
          items: { type: 'object' },
        },
        file_risks: {
          type: 'array',
          description: 'Archobs file risk metrics with cluster_id (from archobs show risks --format json)',
          items: { type: 'object' },
        },
        drift: {
          type: 'object',
          description: 'Most recent archobs drift entry (from archobs show drift --format json)',
        },
        commit_messages: {
          type: 'array',
          description: 'Optional: [{commit_sha, subject}] for pattern extraction',
          items: { type: 'object' },
        },
        window_days: {
          type: 'number',
          description: 'Analysis window in days (default: 30)',
        },
      },
      required: ['commits', 'clusters'],
    },
  },
];

export async function startMcpServer(dbPath: string): Promise<void> {
  const server = new Server(
    { name: 'intel', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Single reader for server lifetime
  const db = openReader(dbPath);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case 'intel_trends':
          result = computeTrends(db, {
            window: params.window as string | undefined,
            top: params.top as number | undefined,
            since: params.since as string | undefined,
            dedup: params.dedup as string | undefined,
          });
          break;

        case 'intel_search':
          result = searchEvents(db, params.query as string, {
            source: params.source as SourceType | undefined,
            topic: params.topic as string | undefined,
            since: params.since as string | undefined,
            limit: params.limit as number | undefined,
            cursor: params.cursor as string | undefined,
          });
          break;

        case 'intel_events':
          if (params.id) {
            result = getEvent(db, params.id as string);
          } else {
            result = listEvents(db, {
              topic: params.topic as string | undefined,
              source: params.source as SourceType | undefined,
              since: params.since as string | undefined,
              limit: params.limit as number | undefined,
              cursor: params.cursor as string | undefined,
            });
          }
          break;

        case 'intel_sources':
          result = querySources(db, {
            stale: params.stale as string | undefined,
          });
          break;

        case 'intel_topics':
          result = queryTopics(db, {
            active: params.active as boolean | undefined,
            match: params.match as string | undefined,
          });
          break;

        case 'intel_stats':
          result = queryStats(db, dbPath);
          break;

        case 'intel_pack':
          result = buildPack(db, {
            since: params.since as string | undefined,
            top: params.top as number | undefined,
            maxEvents: params.max_events as number | undefined,
          });
          break;

        case 'intel_forecast':
          result = computeForecast(db, {
            lag_window_days: params.lag_window_days as number | undefined,
            min_support: params.min_support as number | undefined,
            top_scenarios: params.top_scenarios as number | undefined,
            dedup: params.dedup as string | undefined,
          });
          break;

        case 'intel_change_trajectory': {
          const trajectoryInput: TrajectoryInput = {
            commits: (params.commits as TrajectoryInput['commits']) ?? [],
            clusters: (params.clusters as TrajectoryInput['clusters']) ?? [],
            file_risks: params.file_risks as TrajectoryInput['file_risks'],
            drift: params.drift as TrajectoryInput['drift'],
            commit_messages: params.commit_messages as TrajectoryInput['commit_messages'],
            window_days: params.window_days as number | undefined,
          };
          result = computeTrajectory(trajectoryInput);
          break;
        }

        case 'intel_risk_overlay': {
          const topics = getLoadedTopics().length > 0 ? getLoadedTopics() : loadTopics();
          const forecastResult = computeForecast(db);
          const archobsInput: ArchobsInput = {
            clusters: (params.clusters as ArchobsInput['clusters']) ?? [],
            file_risks: params.file_risks as ArchobsInput['file_risks'],
            drift: params.drift as ArchobsInput['drift'],
            import_specifiers: params.import_specifiers as ArchobsInput['import_specifiers'],
          };
          result = composeRiskIntelligence(archobsInput, forecastResult.data, topics);
          break;
        }

        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  // Handle cleanup
  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[intel] MCP server started on stdio');
}
