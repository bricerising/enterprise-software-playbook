import { describe, it, expect } from 'vitest';
import {
  matchTopicsFromPaths,
  matchTopicsFromImports,
  composeRiskIntelligence,
} from '../src/queries/risk-intelligence.js';
import type {
  ArchobsInput,
  ArchobsClusterInput,
  ArchobsRiskInput,
  ArchobsDriftInput,
} from '../src/queries/risk-intelligence.js';
import type { TopicDef } from '../src/collector/topic-classifier.js';
import type { ForecastData, DynamicItem, LifecycleItem } from '../src/queries/forecast.js';

/* ── Test fixtures ─────────────────────────────────────────────────── */

const TOPICS: TopicDef[] = [
  {
    id: 'security.appsec',
    label: 'Application Security',
    keywords: ['authentication', 'authorization', 'oauth', 'security'],
    priority: 2,
  },
  {
    id: 'aws.lambda',
    label: 'AWS Lambda',
    keywords: ['lambda'],
    priority: 1,
    context_required: true,
    context_terms: ['aws', 'serverless'],
  },
  {
    id: 'ai.openai',
    label: 'OpenAI',
    keywords: ['openai'],
    priority: 1,
  },
  {
    id: 'ai.llm',
    label: 'Large Language Models',
    keywords: ['llm', 'language model'],
    priority: 1,
  },
  {
    id: 'cloud.kubernetes',
    label: 'Kubernetes',
    keywords: ['kubernetes', 'k8s'],
    priority: 1,
  },
];

function makeLifecycle(overrides: Partial<LifecycleItem> & { topic: string }): LifecycleItem {
  return {
    phase: 'stable',
    phase_confidence: 0.8,
    phase_probabilities: { stable: 0.8 },
    volumes: { '1d': 5, '7d': 20, '14d': 40, '30d': 80 },
    accelerations: { '1d': 0, '7d': 0, '14d': 0, '30d': 0 },
    change_points: [],
    ...overrides,
  };
}

function makeForecast(overrides: Partial<ForecastData> = {}): ForecastData {
  return {
    window: { start: '2025-01-01T00:00:00Z', end: '2025-01-31T00:00:00Z', events_analyzed: 100 },
    lifecycles: [],
    chains: [],
    ranked_chains: [],
    scenarios: [],
    multiscale: [],
    transitive_chains: [],
    entropy: [],
    dynamics: [],
    ...overrides,
  };
}

function makeCluster(overrides: Partial<ArchobsClusterInput> & { cluster_id: number }): ArchobsClusterInput {
  return {
    leakage: 0.10,
    cohesion: 0.80,
    risk_mean: 0.30,
    risk_max: 0.40,
    top_paths: [],
    ...overrides,
  };
}

/* ── Topic matching: paths ─────────────────────────────────────────── */

describe('matchTopicsFromPaths', () => {
  it('matches path tokens against topic keywords', () => {
    const result = matchTopicsFromPaths(
      ['src/auth/oauth-handler.ts'],
      1,
      TOPICS,
    );
    expect(result.length).toBeGreaterThanOrEqual(1);
    const secMatch = result.find((r) => r.topic === 'security.appsec');
    expect(secMatch).toBeDefined();
    expect(secMatch!.cluster_id).toBe(1);
    expect(secMatch!.matched_by).toBe('path');
    expect(secMatch!.match_source).toBe('src/auth/oauth-handler.ts');
  });

  it('filters noise tokens (src, index, dist, extensions)', () => {
    const result = matchTopicsFromPaths(
      ['src/index.ts'],
      1,
      TOPICS,
    );
    expect(result).toEqual([]);
  });

  it('skips context_required topics when matching from paths', () => {
    const result = matchTopicsFromPaths(
      ['src/services/lambda-handler.ts'],
      1,
      TOPICS,
    );
    const lambdaMatch = result.find((r) => r.topic === 'aws.lambda');
    expect(lambdaMatch).toBeUndefined();
  });

  it('deduplicates same topic matched by multiple paths in same cluster', () => {
    const result = matchTopicsFromPaths(
      ['src/auth/login.ts', 'src/auth/oauth.ts', 'src/auth/session.ts'],
      1,
      TOPICS,
    );
    const secMatches = result.filter((r) => r.topic === 'security.appsec');
    expect(secMatches).toHaveLength(1);
  });

  it('returns empty for empty paths', () => {
    expect(matchTopicsFromPaths([], 1, TOPICS)).toEqual([]);
  });
});

/* ── Topic matching: imports ───────────────────────────────────────── */

describe('matchTopicsFromImports', () => {
  it('matches import specifier against topic keywords', () => {
    const result = matchTopicsFromImports(
      ['@aws-sdk/client-lambda'],
      TOPICS,
    );
    const match = result.find((r) => r.topic === 'aws.lambda');
    expect(match).toBeDefined();
    expect(match!.matched_by).toBe('import');
    expect(match!.cluster_id).toBe(-1);
  });

  it('matches openai import', () => {
    const result = matchTopicsFromImports(['openai'], TOPICS);
    const match = result.find((r) => r.topic === 'ai.openai');
    expect(match).toBeDefined();
  });

  it('includes context_required topics for imports (sufficient context)', () => {
    const result = matchTopicsFromImports(
      ['@aws-sdk/client-lambda'],
      TOPICS,
    );
    const lambdaMatch = result.find((r) => r.topic === 'aws.lambda');
    expect(lambdaMatch).toBeDefined();
  });

  it('returns empty for empty specifiers', () => {
    expect(matchTopicsFromImports([], TOPICS)).toEqual([]);
  });

  it('deduplicates same topic matched by multiple specifiers', () => {
    const result = matchTopicsFromImports(
      ['openai', '@openai/sdk'],
      TOPICS,
    );
    const openaiMatches = result.filter((r) => r.topic === 'ai.openai');
    expect(openaiMatches).toHaveLength(1);
  });
});

/* ── Compound signal: compounding_risk ─────────────────────────────── */

describe('compound signal: compounding_risk', () => {
  it('fires when cluster risk_max > 0.5 and reinforcing_loop in relevant topic', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        risk_max: 0.7,
        top_paths: ['src/auth/oauth.ts'],
      })],
    };
    const dynamics: DynamicItem[] = [{
      type: 'reinforcing_loop',
      topics: ['security.appsec', 'cloud.kubernetes'],
      metric: { name: 'directionality', value: 0.5, secondary_value: 2.1 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'compounding_risk');
    expect(signals).toHaveLength(1);
    expect(signals[0].cluster_id).toBe(1);
    expect(signals[0].archobs_metric.value).toBe(0.7);
  });

  it('does not fire when risk_max <= 0.5', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        risk_max: 0.3,
        top_paths: ['src/auth/oauth.ts'],
      })],
    };
    const dynamics: DynamicItem[] = [{
      type: 'reinforcing_loop',
      topics: ['security.appsec', 'cloud.kubernetes'],
      metric: { name: 'directionality', value: 0.5, secondary_value: 2.1 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'compounding_risk');
    expect(signals).toHaveLength(0);
  });
});

/* ── Compound signal: pressure_breach ──────────────────────────────── */

describe('compound signal: pressure_breach', () => {
  it('fires when cluster leakage > 0.20 and accumulation in relevant topic', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 2,
        leakage: 0.30,
        top_paths: ['src/auth/session.ts'],
      })],
    };
    const dynamics: DynamicItem[] = [{
      type: 'accumulation',
      topics: ['security.appsec'],
      metric: { name: 'normalized_entropy', value: 0.75 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'pressure_breach');
    expect(signals).toHaveLength(1);
    expect(signals[0].archobs_metric.name).toBe('leakage');
    expect(signals[0].archobs_metric.value).toBe(0.30);
  });

  it('does not fire when leakage <= 0.20', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 2,
        leakage: 0.10,
        top_paths: ['src/auth/session.ts'],
      })],
    };
    const dynamics: DynamicItem[] = [{
      type: 'accumulation',
      topics: ['security.appsec'],
      metric: { name: 'normalized_entropy', value: 0.75 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'pressure_breach');
    expect(signals).toHaveLength(0);
  });
});

/* ── Compound signal: slow_response ────────────────────────────────── */

describe('compound signal: slow_response', () => {
  it('fires when drift ari_prev < 0.50 and delay in relevant topic', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        top_paths: ['src/auth/oauth.ts'],
      })],
      drift: { ari_prev: 0.40, modularity: 0.6, cluster_count: 5 },
    };
    const dynamics: DynamicItem[] = [{
      type: 'delay',
      topics: ['security.appsec', 'ai.llm'],
      metric: { name: 'avg_lag_days', value: 3.5, secondary_value: 1.2 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'slow_response');
    expect(signals).toHaveLength(1);
    expect(signals[0].archobs_metric.value).toBe(0.40);
    expect(signals[0].forecast_metric.value).toBe(3.5);
  });

  it('does not fire when ari_prev >= 0.50', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        top_paths: ['src/auth/oauth.ts'],
      })],
      drift: { ari_prev: 0.70, modularity: 0.6, cluster_count: 5 },
    };
    const dynamics: DynamicItem[] = [{
      type: 'delay',
      topics: ['security.appsec', 'ai.llm'],
      metric: { name: 'avg_lag_days', value: 3.5, secondary_value: 1.2 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'slow_response');
    expect(signals).toHaveLength(0);
  });
});

/* ── Compound signal: declining_hub ────────────────────────────────── */

describe('compound signal: declining_hub', () => {
  it('fires when file hubness > 0.45 and dampening in relevant topic', () => {
    const fileRisks: ArchobsRiskInput[] = [{
      path: 'src/auth/oauth.ts',
      risk: 0.6,
      xnbr: 8,
      hubness: 0.50,
      volatility: 0.3,
      cluster_id: 1,
    }];
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        top_paths: ['src/auth/oauth.ts'],
      })],
      file_risks: fileRisks,
    };
    const dynamics: DynamicItem[] = [{
      type: 'dampening',
      topics: ['security.appsec'],
      metric: { name: 'change_point_days_ago', value: 5 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'declining_hub');
    expect(signals).toHaveLength(1);
    expect(signals[0].archobs_metric.name).toBe('hubness');
    expect(signals[0].archobs_metric.value).toBe(0.50);
  });

  it('does not fire when hubness <= 0.45', () => {
    const fileRisks: ArchobsRiskInput[] = [{
      path: 'src/auth/oauth.ts',
      risk: 0.6,
      xnbr: 8,
      hubness: 0.30,
      volatility: 0.3,
      cluster_id: 1,
    }];
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        top_paths: ['src/auth/oauth.ts'],
      })],
      file_risks: fileRisks,
    };
    const dynamics: DynamicItem[] = [{
      type: 'dampening',
      topics: ['security.appsec'],
      metric: { name: 'change_point_days_ago', value: 5 },
      interpretation: 'test',
    }];
    const forecast = makeForecast({ dynamics });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    const signals = result.compound_signals.filter((s) => s.type === 'declining_hub');
    expect(signals).toHaveLength(0);
  });
});

/* ── Edge cases ────────────────────────────────────────────────────── */

describe('edge cases', () => {
  it('returns empty for no archobs clusters', () => {
    const result = composeRiskIntelligence(
      { clusters: [] },
      makeForecast(),
      TOPICS,
    );
    expect(result.clusters).toEqual([]);
    expect(result.compound_signals).toEqual([]);
    expect(result.topic_relevance).toEqual([]);
  });

  it('returns empty compound_signals when no matching dynamics', () => {
    const archobs: ArchobsInput = {
      clusters: [makeCluster({
        cluster_id: 1,
        risk_max: 0.8,
        top_paths: ['src/auth/oauth.ts'],
      })],
    };
    const forecast = makeForecast({ dynamics: [] });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    expect(result.compound_signals).toEqual([]);
    expect(result.clusters).toHaveLength(1);
  });
});

/* ── Integration: composeRiskIntelligence ──────────────────────────── */

describe('composeRiskIntelligence integration', () => {
  it('produces complete output structure', () => {
    const archobs: ArchobsInput = {
      clusters: [
        makeCluster({
          cluster_id: 0,
          risk_max: 0.7,
          leakage: 0.25,
          top_paths: ['src/auth/oauth.ts', 'src/auth/session.ts'],
        }),
        makeCluster({
          cluster_id: 1,
          risk_max: 0.3,
          top_paths: ['src/api/handler.ts'],
        }),
      ],
      file_risks: [{
        path: 'src/auth/oauth.ts',
        risk: 0.7,
        xnbr: 10,
        hubness: 0.55,
        volatility: 0.4,
        cluster_id: 0,
      }],
      drift: { ari_prev: 0.45, modularity: 0.6, cluster_count: 5 },
      import_specifiers: ['openai', '@aws-sdk/client-lambda'],
    };

    const dynamics: DynamicItem[] = [
      {
        type: 'reinforcing_loop',
        topics: ['security.appsec', 'ai.openai'],
        metric: { name: 'directionality', value: 0.5, secondary_value: 1.8 },
        interpretation: 'security.appsec and ai.openai amplify each other',
      },
      {
        type: 'accumulation',
        topics: ['security.appsec'],
        metric: { name: 'normalized_entropy', value: 0.75 },
        interpretation: 'security.appsec is accumulating pressure',
      },
      {
        type: 'delay',
        topics: ['ai.openai', 'ai.llm'],
        metric: { name: 'avg_lag_days', value: 2.5, secondary_value: 0.8 },
        interpretation: 'delay between ai.openai and ai.llm',
      },
      {
        type: 'dampening',
        topics: ['security.appsec'],
        metric: { name: 'change_point_days_ago', value: 3 },
        interpretation: 'security.appsec is dampening',
      },
    ];

    const lifecycles: LifecycleItem[] = [
      makeLifecycle({ topic: 'security.appsec', phase: 'accelerating', phase_confidence: 0.85 }),
      makeLifecycle({ topic: 'ai.openai', phase: 'emerging', phase_confidence: 0.7 }),
      makeLifecycle({ topic: 'ai.llm', phase: 'stable', phase_confidence: 0.9 }),
    ];

    const forecast = makeForecast({ dynamics, lifecycles });
    const result = composeRiskIntelligence(archobs, forecast, TOPICS);

    // Structure checks
    expect(result.clusters).toHaveLength(2);
    expect(result.topic_relevance.length).toBeGreaterThan(0);
    expect(Array.isArray(result.compound_signals)).toBe(true);

    // Cluster 0 should have relevant topics from auth paths
    const c0 = result.clusters[0];
    expect(c0.cluster_id).toBe(0);
    expect(c0.relevant_topics).toContain('security.appsec');
    expect(c0.archobs.leakage).toBe(0.25);
    expect(c0.archobs.risk_max).toBe(0.7);

    // Import-matched topics should appear in all clusters
    const c1 = result.clusters[1];
    expect(c1.relevant_topics).toContain('ai.openai');
    expect(c1.relevant_topics).toContain('aws.lambda');

    // Should have compound signals (cluster 0 triggers all four):
    // - compounding_risk: risk_max > 0.5 + reinforcing_loop
    // - pressure_breach: leakage > 0.20 + accumulation
    // - slow_response: ari_prev < 0.50 + delay
    // - declining_hub: hubness > 0.45 + dampening
    const types = result.compound_signals.map((s) => s.type);
    expect(types).toContain('compounding_risk');
    expect(types).toContain('pressure_breach');
    expect(types).toContain('slow_response');
    expect(types).toContain('declining_hub');

    // Relevant lifecycles should be populated
    expect(c0.relevant_lifecycles.length).toBeGreaterThan(0);
    const secLC = c0.relevant_lifecycles.find((l) => l.topic === 'security.appsec');
    expect(secLC).toBeDefined();
    expect(secLC!.phase).toBe('accelerating');
  });
});
