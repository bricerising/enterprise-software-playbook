import type Database from 'better-sqlite3';
import { sinceISO as _sinceISO, formatISO } from '../../util/time.js';
import { sanitizeSnippet } from '../../util/text.js';

/* ── SQL expressions ────────────────────────────────────────────────── */

/** SQL expression for real-world event timestamp (publication time, fetch-time fallback).
 *  Temporal analysis must use this instead of raw fetched_at so that bulk ingests
 *  don't compress weeks of signal into a single calendar day. */
export const PUB_TS = 'COALESCE(e.published_at, e.fetched_at)';
export const PUB_DAY = `DATE(${PUB_TS})`;

/* ── Window definitions ─────────────────────────────────────────────── */

export const WINDOWS = [
  { label: '1d', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
  { label: '14d', ms: 1_209_600_000 },
  { label: '30d', ms: 2_592_000_000 },
  { label: '90d', ms: 7_776_000_000 },
] as const;

/* ── Constants ──────────────────────────────────────────────────────── */

export const MAX_TITLES_PER_SCENARIO = 3;

/* ── Spec 014: Confidence gate constants ───────────────────────────── */

/** Data age threshold below which cold-start applies.
 *  Aligned with spec 015's MIN_DATA_AGE_DAYS. */
export const MIN_LIFECYCLE_DAYS = 90;

/** Floor of the graduated confidence cap at 0 days of data. */
export const MIN_COLD_START_CONFIDENCE = 0.3;

/** Minimum events for a topic to not be flagged as insufficient. */
export const MIN_TOPIC_EVENTS = 50;

/** Minimum events per topic for a chain to avoid `spurious` tier.
 *  Aligned with MIN_TOPIC_EVENTS. */
export const MIN_CHAIN_TOPIC_EVENTS = 50;

/** Minimum topic volume (both topics) for `high` confidence tier. */
export const CHAIN_TIER_HIGH_VOLUME = 500;
/** Minimum source diversity for `high` confidence tier. */
export const CHAIN_TIER_HIGH_DIVERSITY = 0.6;
/** Minimum support for `high` confidence tier. */
export const CHAIN_TIER_HIGH_SUPPORT = 30;

/** Minimum topic volume (both topics) for `moderate` confidence tier. */
export const CHAIN_TIER_MODERATE_VOLUME = 100;
/** Minimum source diversity for `moderate` confidence tier. */
export const CHAIN_TIER_MODERATE_DIVERSITY = 0.5;
/** Minimum support for `moderate` confidence tier. */
export const CHAIN_TIER_MODERATE_SUPPORT = 10;

/** Decimal places for scenario score rounding. */
export const SCENARIO_DECIMAL_PLACES = 3;

/** Exponential decay half-life in days. Chains with recent co-occurrences
 *  are weighted higher than old ones. */
export const DECAY_HALF_LIFE_DAYS = 14;
export const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_DAYS;

/** CUSUM change-point detection sensitivity.
 *  k = allowance (slack) in standard deviations; h = decision threshold. */
export const CUSUM_K_SIGMA = 0.5;
export const CUSUM_H_SIGMA = 4.0;

/** Days within which a CUSUM change point discounts chain reliability.
 *  A change point 0 days ago → full discount; at the horizon → no discount. */
export const CUSUM_DISCOUNT_HORIZON_DAYS = 7;

/** Softmax temperature for scenario scoring. Values < 1.0 sharpen the
 *  score distribution so top scenarios differentiate from the rest.
 *  1.0 = standard softmax; 0.5 = doubled log-posterior differences.
 *  Note: the resulting scores are NOT calibrated probabilities — they are
 *  relative rankings that sum to ~1.0. Use for ordering, not for estimating
 *  real-world likelihood. */
export const SOFTMAX_TEMPERATURE = 0.5;

/** Maximum trigger chains that contribute to any single target's posterior.
 *  Prevents posterior saturation when many triggers are simultaneously active. */
export const MAX_CHAINS_PER_TARGET = 5;

/** Maximum ranked chains per trigger topic in the top-50.
 *  Ensures diverse trigger representation; high-base-rate triggers
 *  don't monopolize all ranked chain slots. */
export const MAX_RANKED_PER_TRIGGER = 3;

/** Maximum transitive chains per A→B prefix in the top-100.
 *  Ensures diverse cross-domain paths rather than five variations
 *  of the same cascade (e.g., all sharing ai.foundation-models→compute.gpu prefix). */
export const MAX_TRANSITIVE_PER_PREFIX = 3;

/** Maximum dynamics entries per type. Keeps output manageable for synthesis. */
export const MAX_DYNAMICS_PER_TYPE = 10;

/** HMM-style Gaussian emission model parameters.
 *  Each phase has expected accelerations at each window and a spread. */
export const PHASE_EMISSIONS: Record<
  string,
  { means: Record<string, number>; stddev: number }
> = {
  emerging:     { means: { '1d': 1.0, '7d': 0.5, '14d': 0.2, '30d': 0.0, '90d': -0.1 }, stddev: 0.5 },
  accelerating: { means: { '1d': 0.5, '7d': 0.5, '14d': 0.3, '30d': 0.3, '90d': 0.2 }, stddev: 0.4 },
  peaking:      { means: { '1d': -0.3, '7d': 0.3, '14d': 0.2, '30d': 0.1, '90d': 0.1 }, stddev: 0.4 },
  decaying:     { means: { '1d': -0.5, '7d': -0.3, '14d': -0.2, '30d': -0.1, '90d': 0.0 }, stddev: 0.4 },
  stable:       { means: { '1d': 0.0, '7d': 0.0, '14d': 0.0, '30d': 0.0, '90d': 0.0 }, stddev: 0.15 },
};

/** Compact mode limits per section. */
export const COMPACT_LIMITS = {
  lifecycles: 15,
  chains: 15,
  ranked_chains: 10,
  scenarios: 10,
  multiscale: 15,
  transitive_chains: 10,
  entropy: 15,
  dynamics_per_type: 5,
} as const;

/** Summary mode limits — aggressive reduction for fast agent synthesis. */
export const SUMMARY_LIMITS = {
  lifecycles: 0,
  chains: 0,
  ranked_chains: 5,
  scenarios: 3,
  multiscale: 0,
  transitive_chains: 0,
  entropy: 0,
  dynamics_per_type: 1,
} as const;

/** Max titles per topic in the context section. */
export const CONTEXT_TITLES_PER_TOPIC = 3;

/** Snapshot retention: auto-delete snapshots older than 90 days. */
export const SNAPSHOT_RETENTION_DAYS = 90;

/** Minimum evaluated outcomes before updating topic weight. */
export const MIN_OUTCOMES_FOR_WEIGHT = 5;

/** Floor for learned topic weight. Ensures even poorly-performing topics
 *  retain some classifier influence. Formula:
 *  weight = WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * max(0, skill)
 *  where skill = 1 - brier / brier_ref (Brier Skill Score). */
export const WEIGHT_FLOOR = 0.5;

/* ── Spec 014: Confidence gate types ───────────────────────────────── */

export type ConfidenceTier = 'spurious' | 'low' | 'moderate' | 'high';

export interface ChainTierCounts {
  spurious: number;
  low: number;
  moderate: number;
  high: number;
}

export interface DataQuality {
  data_age_days: number;
  cold_start: boolean;
  total_events: number;
  lifecycle_topic_count: number;
  insufficient_data_count: number;
  insufficient_data_pct: number;
  window_unclassified_pct: number;
  window_top_source_name: string;
  window_top_source_pct: number;
  chain_tier_counts: ChainTierCounts;
}

/* ── Interfaces ─────────────────────────────────────────────────────── */

export interface ChangePointSummary {
  topic: string;
  days_ago: number;
}

/** Inline context titles for a topic, used by --with-context to save deepening round-trips. */
export interface TopicContext {
  topic: string;
  titles: string[];
  /** Event titles from around the break date (±2 days) for change-point topics
   *  where the break is old enough (days_ago > 3) that regular `titles` may not
   *  capture the mechanism that caused the structural shift. */
  break_titles?: string[];
  /** How many days ago the most recent structural break occurred for this topic. */
  break_days_ago?: number;
}

export interface ForecastData {
  window: { start: string; end: string; events_analyzed: number };
  /** Omitted in summary mode (limit 0). */
  lifecycles?: LifecycleItem[];
  /** Omitted in summary mode (limit 0). */
  chains?: ChainItem[];
  ranked_chains: RankedChainItem[];
  scenarios: ScenarioItem[];
  /** Omitted in summary mode (limit 0). */
  multiscale?: MultiscaleItem[];
  /** Omitted in summary mode (limit 0). */
  transitive_chains?: TransitiveChainItem[];
  /** Omitted in summary mode (limit 0). */
  entropy?: EntropyItem[];
  dynamics: DynamicItem[];
  change_points_summary: ChangePointSummary[];
  /** Present when --with-context is used. Top event titles per change point topic
   *  and per top ranked chain topic, inlined to save deepening round-trips. */
  context?: TopicContext[];
  /** Always present; survives --section filtering. */
  data_quality: DataQuality;
}

export interface LifecycleItem {
  topic: string;
  phase: 'emerging' | 'accelerating' | 'peaking' | 'decaying' | 'stable';
  phase_confidence: number;
  phase_probabilities?: Record<string, number>;
  volumes: Record<string, number>;
  accelerations: Record<string, number>;
  change_points: number[];
  /** True when data_age_days < 90; omitted when false. */
  cold_start?: boolean;
  /** True when topic has < 50 events in the analysis window; omitted when false. */
  insufficient_data?: boolean;
}

export interface ChainItem {
  from_topic: string;
  to_topic: string;
  support: number;
  avg_lag_days: number;
  source_diversity: number;
  active: boolean;
  lift: number;
  confidence: number;
  directionality: number;
  lag_stddev: number;
  decay_weighted_support: number;
  /** Fraction of window days on which the trigger topic spikes (0-1).
   *  High values (> 0.5) indicate omnipresent topics whose chains are less informative. */
  trigger_base_rate: number;
  /** Calendar artifact hint. Present when co-occurrences cluster on weekdays.
   *  'weekday_correlated' = both trigger and target spike predominantly Mon-Fri
   *  and co-occurrences are >75% weekday. Likely a calendar cadence, not causal. */
  temporal_pattern?: 'weekday_correlated';
  /** Fraction of co-occurrence days that fall on weekdays (Mon-Fri) for this
   *  chain's trigger and target, averaged. Always present so consumers can
   *  programmatically assess calendar artifacts even below the binary threshold. */
  weekday_ratio: number;
  /** Data-quality classification based on underlying topic volume, source diversity, and support. */
  confidence_tier: ConfidenceTier;
}

export interface TransitiveChainItem {
  path: string[];
  total_lag_days: number;
  min_support: number;
  combined_lift: number;
  cross_domain: boolean;
  /** Geometric mean of the two leg confidences — calibrated [0,1] score
   *  that accounts for uncertainty compounding in multi-hop chains.
   *  More useful than combined_lift for comparing transitive chain strength. */
  normalized_confidence: number;
}

export interface RankedChainItem extends ChainItem {
  score: number;
  cross_domain: boolean;
}

export interface ScenarioItem {
  target_topic: string;
  /** Relative scenario score (0-1, sums to ~1.0 across all scenarios).
   *  Derived from temperature-scaled softmax over Bayesian log-posteriors.
   *  NOT a calibrated probability — use for ranking scenarios, not for
   *  estimating real-world likelihood. Higher = more statistically interesting. */
  score: number;
  timeframe_days: [number, number];
  trigger_topics: string[];
  supporting_chains: number;
  evidence_titles: string[];
  /** Parallel array with evidence_titles: per-title relevance hint based on
   *  how many topics the source event was assigned to. Fewer topics = more
   *  specific classification = higher confidence the title is actually relevant.
   *  'high' = 1-2 topics, 'medium' = 3-4, 'low' = 5 (classifier may be noisy). */
  evidence_relevance: Array<'high' | 'medium' | 'low'>;
  target_entropy: number;
  /** Fraction of window days on which the target topic spikes (0-1).
   *  High values (> 0.8) indicate omnipresent targets — predicting they'll
   *  spike is trivially true and not actionable. */
  target_base_rate: number;
  /** Worst confidence tier among contributing chains. */
  min_chain_tier: ConfidenceTier;
}

export interface EntropyItem {
  topic: string;
  entropy: number;
  normalized_entropy: number;
  active_days: number;
}

export interface MultiscaleItem {
  topic: string;
  alignment: 'aligned_up' | 'aligned_down' | 'diverging' | 'transitioning';
  d1_accel: number;
  d7_accel: number;
  d30_accel: number;
  d90_accel: number;
}

export type DynamicType = 'reinforcing_loop' | 'delay' | 'accumulation' | 'dampening';

export interface DynamicItem {
  type: DynamicType;
  topics: string[];
  metric: { name: string; value: number; secondary_value?: number };
  interpretation: string;
}

export interface ComputeForecastOpts {
  lag_window_days?: number;
  min_support?: number;
  top_scenarios?: number;
  dedup?: string;
  /** Overall analysis window in days (default: 120). Accepted values: 7, 14, 30, 60, 90, 120. */
  window_days?: number;
  /** When true, return a compact summary (top-N per section) instead of full output. */
  compact?: boolean;
  /** When true, return a minimal summary (top-3 scenarios, top-5 chains, top-3 dynamics,
   *  change points) for fast agent consumption. Implies compact. */
  summary?: boolean;
  /** When true, inline top event titles per change point topic and per top ranked chain
   *  topic. Saves a round-trip of `intel search` deepening calls. */
  with_context?: boolean;
  /** Filter output to specific topic IDs (e.g., ['ai.foundation-models', 'compute.gpu']).
   *  The full pipeline runs but output is post-filtered to only include data
   *  relating to these topics. Eliminates the need to run the full forecast
   *  twice to extract lifecycle/multiscale/entropy for specific topics. */
  topics?: string[];
  /** Filter output to specific section names (e.g., ['lifecycles', 'entropy']).
   *  Only these sections are included in the response. Valid values:
   *  lifecycles, chains, ranked_chains, scenarios, multiscale,
   *  transitive_chains, entropy, dynamics, change_points_summary, context. */
  sections?: string[];
}

export interface SnapshotResult {
  snapshot_id: number;
  scenarios_saved: number;
  snapshots_pruned: number;
}

export interface EvaluateResult {
  evaluated: number;
  skipped: number;
  weights_updated: number;
}

/* ── Utility functions ──────────────────────────────────────────────── */

/** sinceISO with optional explicit `now` for deterministic window alignment. */
export function sinceISO(durationMs: number, now?: number): string {
  if (now === undefined) return _sinceISO(durationMs);
  return formatISO(new Date(now - durationMs));
}

export { formatISO, sanitizeSnippet };

/** Convert a Date to a Julian day number (for age calculations matching SQL JULIANDAY). */
export function julianDay(d: Date): number {
  return d.getTime() / 86_400_000 + 2_440_587.5;
}

/* ── Database type re-export ────────────────────────────────────────── */

export type { Database };
