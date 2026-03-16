import type { TopicDef } from '../collector/topic-classifier.js';
import type {
  ForecastData,
  DynamicItem,
  LifecycleItem,
} from './forecast.js';

/* ── Archobs input types (matching archobs show --format json shape) ── */

export interface ArchobsClusterInput {
  cluster_id: number;
  leakage: number;
  cohesion: number;
  risk_mean: number;
  risk_max: number;
  top_paths: string[];
}

export interface ArchobsRiskInput {
  path: string;
  risk: number;
  xnbr: number;
  hubness: number;
  volatility: number;
  cluster_id: number;
}

export interface ArchobsDriftInput {
  ari_prev: number;
  modularity: number;
  cluster_count: number;
}

export interface ArchobsInput {
  clusters: ArchobsClusterInput[];
  file_risks?: ArchobsRiskInput[];
  drift?: ArchobsDriftInput;
  import_specifiers?: string[];
}

/* ── Output types ──────────────────────────────────────────────────── */

export type CompoundSignalType =
  | 'compounding_risk'
  | 'pressure_breach'
  | 'slow_response'
  | 'declining_hub';

export interface CompoundSignal {
  type: CompoundSignalType;
  cluster_id: number;
  topics: string[];
  archobs_metric: { name: string; value: number };
  forecast_metric: { name: string; value: number };
  interpretation: string;
}

export interface TopicRelevanceItem {
  topic: string;
  cluster_id: number;
  matched_by: 'path' | 'import';
  match_source: string;
}

export interface RiskIntelligenceCluster {
  cluster_id: number;
  top_paths: string[];
  archobs: { leakage: number; cohesion: number; risk_mean: number; risk_max: number };
  relevant_topics: string[];
  relevant_dynamics: DynamicItem[];
  relevant_lifecycles: { topic: string; phase: string; phase_confidence: number }[];
}

export interface RiskIntelligenceData {
  clusters: RiskIntelligenceCluster[];
  compound_signals: CompoundSignal[];
  topic_relevance: TopicRelevanceItem[];
}

/* ── Constants ─────────────────────────────────────────────────────── */

const NOISE_TOKENS = new Set([
  'src', 'lib', 'test', 'tests', 'index', 'dist', 'node_modules',
  '__tests__', 'build', 'out', 'bin', 'pkg', 'cmd', 'internal',
]);

const NOISE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'md', 'css',
  'scss', 'html', 'go', 'py', 'rs', 'java', 'kt', 'swift',
]);

/* ── Topic matching ────────────────────────────────────────────────── */

/** Tokenize a file path into meaningful segments. */
function tokenizePath(path: string): string[] {
  return path
    .split(/[/.\-_]/)
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t) && !NOISE_EXTENSIONS.has(t));
}

export function matchTopicsFromPaths(
  paths: string[],
  clusterId: number,
  topics: TopicDef[],
): TopicRelevanceItem[] {
  const seen = new Set<string>();
  const results: TopicRelevanceItem[] = [];

  for (const path of paths) {
    const tokens = tokenizePath(path);
    for (const topic of topics) {
      if (topic.context_required) continue;
      if (seen.has(topic.id)) continue;

      for (const token of tokens) {
        const matched = topic.keywords.some((kw) => kw.includes(token) || token.includes(kw));
        if (matched) {
          seen.add(topic.id);
          results.push({
            topic: topic.id,
            cluster_id: clusterId,
            matched_by: 'path',
            match_source: path,
          });
          break;
        }
      }
    }
  }

  return results;
}

export function matchTopicsFromImports(
  specifiers: string[],
  topics: TopicDef[],
): TopicRelevanceItem[] {
  const seen = new Set<string>();
  const results: TopicRelevanceItem[] = [];

  for (const spec of specifiers) {
    const lowerSpec = spec.toLowerCase();

    for (const topic of topics) {
      if (seen.has(topic.id)) continue;

      let matched = topic.keywords.some((kw) => lowerSpec.includes(kw));

      if (!matched && topic.regex) {
        for (const rawPattern of topic.regex) {
          try {
            let pattern = rawPattern;
            let flags = '';
            if (pattern.startsWith('(?i)')) {
              pattern = pattern.slice(4);
              flags = 'i';
            }
            const re = new RegExp(pattern, flags);
            if (re.test(spec)) {
              matched = true;
              break;
            }
          } catch {
            // Invalid regex — skip
          }
        }
      }

      if (matched) {
        seen.add(topic.id);
        results.push({
          topic: topic.id,
          cluster_id: -1,
          matched_by: 'import',
          match_source: spec,
        });
      }
    }
  }

  return results;
}

/* ── Compound signal detectors ─────────────────────────────────────── */

function detectCompoundingRisk(
  clusters: ArchobsClusterInput[],
  clusterTopics: Map<number, Set<string>>,
  dynamics: DynamicItem[],
): CompoundSignal[] {
  const loops = dynamics.filter((d) => d.type === 'reinforcing_loop');
  const results: CompoundSignal[] = [];

  for (const cluster of clusters) {
    if (cluster.risk_max <= 0.5) continue;
    const topics = clusterTopics.get(cluster.cluster_id);
    if (!topics || topics.size === 0) continue;

    for (const loop of loops) {
      const overlap = loop.topics.filter((t) => topics.has(t));
      if (overlap.length === 0) continue;

      const pathSummary = cluster.top_paths.slice(0, 3).join(', ');
      results.push({
        type: 'compounding_risk',
        cluster_id: cluster.cluster_id,
        topics: loop.topics,
        archobs_metric: { name: 'risk_max', value: cluster.risk_max },
        forecast_metric: { name: 'mutual_lift', value: loop.metric.secondary_value ?? loop.metric.value },
        interpretation: `Cluster ${cluster.cluster_id} (${pathSummary}) has high architectural risk (${cluster.risk_max}) and topics ${loop.topics.join('/')} are in a reinforcing loop — instability is compounding`,
      });
    }
  }

  return results;
}

function detectPressureBreach(
  clusters: ArchobsClusterInput[],
  clusterTopics: Map<number, Set<string>>,
  dynamics: DynamicItem[],
): CompoundSignal[] {
  const accumulations = dynamics.filter((d) => d.type === 'accumulation');
  const results: CompoundSignal[] = [];

  for (const cluster of clusters) {
    if (cluster.leakage <= 0.20) continue;
    const topics = clusterTopics.get(cluster.cluster_id);
    if (!topics || topics.size === 0) continue;

    for (const acc of accumulations) {
      const overlap = acc.topics.filter((t) => topics.has(t));
      if (overlap.length === 0) continue;

      results.push({
        type: 'pressure_breach',
        cluster_id: cluster.cluster_id,
        topics: acc.topics,
        archobs_metric: { name: 'leakage', value: cluster.leakage },
        forecast_metric: { name: 'normalized_entropy', value: acc.metric.value },
        interpretation: `Cluster ${cluster.cluster_id} has porous boundaries (leakage ${cluster.leakage}) while ${acc.topics[0]} is accelerating with building pressure — this boundary may breach`,
      });
    }
  }

  return results;
}

function detectSlowResponse(
  drift: ArchobsDriftInput | undefined,
  allTopics: Set<string>,
  dynamics: DynamicItem[],
): CompoundSignal[] {
  if (!drift || drift.ari_prev >= 0.50) return [];

  const delays = dynamics.filter((d) => d.type === 'delay');
  const results: CompoundSignal[] = [];

  for (const delay of delays) {
    const overlap = delay.topics.filter((t) => allTopics.has(t));
    if (overlap.length === 0) continue;

    results.push({
      type: 'slow_response',
      cluster_id: -1,
      topics: delay.topics,
      archobs_metric: { name: 'ari_prev', value: drift.ari_prev },
      forecast_metric: { name: 'avg_lag_days', value: delay.metric.value },
      interpretation: `Architecture is restructuring (ARI ${drift.ari_prev}) while a ${delay.metric.value}-day signal delay exists for ${delay.topics.join('→')} — the codebase may be adapting too slowly`,
    });
  }

  return results;
}

function detectDecliningHub(
  clusters: ArchobsClusterInput[],
  fileRisks: ArchobsRiskInput[],
  clusterTopics: Map<number, Set<string>>,
  dynamics: DynamicItem[],
): CompoundSignal[] {
  const dampenings = dynamics.filter((d) => d.type === 'dampening');
  if (dampenings.length === 0 || fileRisks.length === 0) return [];

  const results: CompoundSignal[] = [];

  // Find high-hubness files per cluster
  const hubsByCluster = new Map<number, ArchobsRiskInput[]>();
  for (const file of fileRisks) {
    if (file.hubness <= 0.45) continue;
    const list = hubsByCluster.get(file.cluster_id);
    if (list) list.push(file);
    else hubsByCluster.set(file.cluster_id, [file]);
  }

  for (const cluster of clusters) {
    const hubs = hubsByCluster.get(cluster.cluster_id);
    if (!hubs || hubs.length === 0) continue;
    const topics = clusterTopics.get(cluster.cluster_id);
    if (!topics || topics.size === 0) continue;

    for (const dampening of dampenings) {
      const overlap = dampening.topics.filter((t) => topics.has(t));
      if (overlap.length === 0) continue;

      const hub = hubs[0]; // highest hubness file in this cluster
      results.push({
        type: 'declining_hub',
        cluster_id: cluster.cluster_id,
        topics: dampening.topics,
        archobs_metric: { name: 'hubness', value: hub.hubness },
        forecast_metric: { name: 'change_point_days_ago', value: dampening.metric.value },
        interpretation: `File ${hub.path} is a high fan-in hub (hubness ${hub.hubness}) in an area where ${dampening.topics[0]} is declining — this hub may be over-invested`,
      });
    }
  }

  return results;
}

/* ── Main composition ──────────────────────────────────────────────── */

export function composeRiskIntelligence(
  archobs: ArchobsInput,
  forecast: ForecastData,
  topics: TopicDef[],
): RiskIntelligenceData {
  if (archobs.clusters.length === 0) {
    return { clusters: [], compound_signals: [], topic_relevance: [] };
  }

  // 1. Build topic relevance: per-cluster path matches + global import matches
  const allRelevance: TopicRelevanceItem[] = [];

  for (const cluster of archobs.clusters) {
    const matches = matchTopicsFromPaths(cluster.top_paths, cluster.cluster_id, topics);
    allRelevance.push(...matches);
  }

  if (archobs.import_specifiers && archobs.import_specifiers.length > 0) {
    const importMatches = matchTopicsFromImports(archobs.import_specifiers, topics);
    allRelevance.push(...importMatches);
  }

  // Build per-cluster topic sets (include global import matches in every cluster)
  const clusterTopics = new Map<number, Set<string>>();
  const globalImportTopics = new Set<string>();

  for (const rel of allRelevance) {
    if (rel.cluster_id === -1) {
      globalImportTopics.add(rel.topic);
    } else {
      let set = clusterTopics.get(rel.cluster_id);
      if (!set) {
        set = new Set();
        clusterTopics.set(rel.cluster_id, set);
      }
      set.add(rel.topic);
    }
  }

  // Merge global import topics into every cluster
  for (const cluster of archobs.clusters) {
    let set = clusterTopics.get(cluster.cluster_id);
    if (!set) {
      set = new Set();
      clusterTopics.set(cluster.cluster_id, set);
    }
    for (const t of globalImportTopics) set.add(t);
  }

  // Collect all relevant topics across all clusters
  const allTopics = new Set<string>();
  for (const set of clusterTopics.values()) {
    for (const t of set) allTopics.add(t);
  }

  // 2. Build lifecycle lookup
  const lifecycleMap = new Map<string, LifecycleItem>();
  for (const lc of forecast.lifecycles) {
    lifecycleMap.set(lc.topic, lc);
  }

  // 3. Build composed cluster views
  const riskClusters: RiskIntelligenceCluster[] = archobs.clusters.map((cluster) => {
    const topics = clusterTopics.get(cluster.cluster_id) ?? new Set<string>();
    const topicArray = [...topics];

    const relevantDynamics = forecast.dynamics.filter((d) =>
      d.topics.some((t) => topics.has(t)),
    );

    const relevantLifecycles = topicArray
      .map((t) => {
        const lc = lifecycleMap.get(t);
        if (!lc) return null;
        return { topic: t, phase: lc.phase, phase_confidence: lc.phase_confidence };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      cluster_id: cluster.cluster_id,
      top_paths: cluster.top_paths,
      archobs: {
        leakage: cluster.leakage,
        cohesion: cluster.cohesion,
        risk_mean: cluster.risk_mean,
        risk_max: cluster.risk_max,
      },
      relevant_topics: topicArray,
      relevant_dynamics: relevantDynamics,
      relevant_lifecycles: relevantLifecycles,
    };
  });

  // 4. Run compound signal detectors
  const compound_signals: CompoundSignal[] = [
    ...detectCompoundingRisk(archobs.clusters, clusterTopics, forecast.dynamics),
    ...detectPressureBreach(archobs.clusters, clusterTopics, forecast.dynamics),
    ...detectSlowResponse(archobs.drift, allTopics, forecast.dynamics),
    ...detectDecliningHub(
      archobs.clusters,
      archobs.file_risks ?? [],
      clusterTopics,
      forecast.dynamics,
    ),
  ];

  return {
    clusters: riskClusters,
    compound_signals,
    topic_relevance: allRelevance,
  };
}
