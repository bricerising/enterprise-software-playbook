import type { ChainItem, LifecycleItem, MultiscaleItem, EntropyItem, DynamicItem } from './types.js';
import { MAX_DYNAMICS_PER_TYPE } from './types.js';

/* ── F2. Systems dynamics detection ────────────────────────────────── */

export function detectDynamics(
  chains: ChainItem[],
  lifecycles: LifecycleItem[],
  multiscale: MultiscaleItem[],
  entropy: EntropyItem[],
  maxPerType: number = MAX_DYNAMICS_PER_TYPE,
  freshTopics?: Set<string>,
): DynamicItem[] {
  // Rank each type by signal strength, then cap
  const loops = detectReinforcingLoops(chains);
  loops.sort((a, b) => (b.metric.secondary_value ?? 0) - (a.metric.secondary_value ?? 0));

  const delays = detectDelays(chains);
  delays.sort((a, b) => (a.metric.secondary_value ?? Infinity) - (b.metric.secondary_value ?? Infinity));

  const accum = detectAccumulations(lifecycles, multiscale, entropy, freshTopics);
  accum.sort((a, b) => b.metric.value - a.metric.value);

  const damp = detectDampening(lifecycles);
  damp.sort((a, b) => a.metric.value - b.metric.value);

  return [
    ...loops.slice(0, maxPerType),
    ...delays.slice(0, maxPerType),
    ...accum.slice(0, maxPerType),
    ...damp.slice(0, maxPerType),
  ];
}

function detectReinforcingLoops(chains: ChainItem[]): DynamicItem[] {
  const lookup = new Map<string, ChainItem>();
  for (const c of chains) {
    lookup.set(`${c.from_topic}→${c.to_topic}`, c);
  }

  const seen = new Set<string>();
  const results: DynamicItem[] = [];

  for (const c of chains) {
    if (c.directionality < 0.3 || c.directionality > 0.7) continue;
    if (c.lift <= 1) continue;

    const reverseKey = `${c.to_topic}→${c.from_topic}`;
    const reverse = lookup.get(reverseKey);
    if (!reverse || reverse.lift <= 1) continue;

    const pairKey = [c.from_topic, c.to_topic].sort().join('↔');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const mutualLift = Math.round(Math.min(c.lift, reverse.lift) * 100) / 100;
    results.push({
      type: 'reinforcing_loop',
      topics: [c.from_topic, c.to_topic],
      metric: { name: 'directionality', value: c.directionality, secondary_value: mutualLift },
      interpretation: `${c.from_topic} and ${c.to_topic} amplify each other (directionality ${c.directionality}, mutual lift ${mutualLift}x)`,
    });
  }

  return results;
}

function detectDelays(chains: ChainItem[]): DynamicItem[] {
  return chains
    .filter((c) => c.active && c.avg_lag_days >= 0.5)
    .map((c) => ({
      type: 'delay' as const,
      topics: [c.from_topic, c.to_topic],
      metric: { name: 'avg_lag_days', value: c.avg_lag_days, secondary_value: c.lag_stddev },
      interpretation: `When ${c.from_topic} spikes, ${c.to_topic} follows in ${c.avg_lag_days}±${c.lag_stddev} days`,
    }));
}

function detectAccumulations(
  lifecycles: LifecycleItem[],
  multiscale: MultiscaleItem[],
  entropy: EntropyItem[],
  freshTopics?: Set<string>,
): DynamicItem[] {
  const msMap = new Map<string, MultiscaleItem>();
  for (const ms of multiscale) msMap.set(ms.topic, ms);

  const entMap = new Map<string, EntropyItem>();
  for (const e of entropy) entMap.set(e.topic, e);

  const results: DynamicItem[] = [];

  for (const lc of lifecycles) {
    if (lc.phase !== 'emerging' && lc.phase !== 'accelerating') continue;

    // Freshness gate: skip topics whose events are all fetched_at fallback
    if (freshTopics && !freshTopics.has(lc.topic)) continue;

    const ms = msMap.get(lc.topic);
    if (!ms || ms.alignment !== 'aligned_up') continue;

    const ent = entMap.get(lc.topic);
    if (!ent || ent.normalized_entropy <= 0.5) continue;

    results.push({
      type: 'accumulation',
      topics: [lc.topic],
      metric: { name: 'normalized_entropy', value: ent.normalized_entropy },
      interpretation: `${lc.topic} is ${lc.phase} with all timescales aligned upward and rising entropy — pressure is accumulating`,
    });
  }

  return results;
}

function detectDampening(lifecycles: LifecycleItem[]): DynamicItem[] {
  const results: DynamicItem[] = [];

  for (const lc of lifecycles) {
    if (lc.phase !== 'decaying') continue;

    const recentCps = lc.change_points.filter((cp) => cp <= 14);
    if (recentCps.length === 0) continue;

    const mostRecent = Math.min(...recentCps);
    results.push({
      type: 'dampening',
      topics: [lc.topic],
      metric: { name: 'change_point_days_ago', value: mostRecent },
      interpretation: `${lc.topic} had a structural break ${mostRecent} days ago and is now decaying — a balancing force may be dampening this signal`,
    });
  }

  return results;
}
