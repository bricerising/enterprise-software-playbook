import type {
  ArchobsClusterInput,
  ArchobsRiskInput,
  ArchobsDriftInput,
} from './risk-intelligence.js';

/* ── Input types ──────────────────────────────────────────────────── */

export interface CommitFileInput {
  commit_sha: string;
  commit_ts: number;        // Unix timestamp (seconds)
  status: 'A' | 'M' | 'D'; // Added, Modified, Deleted
  path: string;
}

export interface CommitMessageInput {
  commit_sha: string;
  subject: string;          // First line of commit message
}

export interface TrajectoryInput {
  commits: CommitFileInput[];
  clusters: ArchobsClusterInput[];
  file_risks?: ArchobsRiskInput[];
  drift?: ArchobsDriftInput;
  commit_messages?: CommitMessageInput[];
  window_days?: number;     // Default: 30
}

/* ── Output types ─────────────────────────────────────────────────── */

export interface ClusterTrajectory {
  cluster_id: number;
  top_paths: string[];
  total_changes: number;
  additions: number;
  modifications: number;
  deletions: number;
  growth_ratio: number;
  churn_ratio: number;
  contraction_ratio: number;
  recent_commits: number;
  velocity_trend: 'accelerating' | 'steady' | 'decelerating' | 'dormant';
  velocity_halves: [number, number];
  recently_added_paths: string[];
  most_modified_paths: string[];
  recently_deleted_paths: string[];
  archobs?: { leakage: number; cohesion: number; risk_mean: number; risk_max: number };
}

export interface ClusterMomentum {
  cluster_id: number;
  share_of_changes: number;
  rank: number;
}

export interface SubjectPatterns {
  top_tokens: Array<{ token: string; count: number }>;
  recent_subjects: string[];
}

export interface TrajectoryData {
  window: { start_ts: number; end_ts: number; total_commits: number; total_file_changes: number };
  clusters: ClusterTrajectory[];
  momentum: ClusterMomentum[];
  concentration_index: number;
  subject_patterns?: SubjectPatterns;
}

/* ── Constants ────────────────────────────────────────────────────── */

const DEFAULT_WINDOW_DAYS = 30;
const VELOCITY_DORMANT_THRESHOLD = 3;
const VELOCITY_ACCELERATION_RATIO = 1.5;
const TOP_MODIFIED_PATHS_CAP = 10;
const TOP_SUBJECT_TOKENS = 15;
const RECENT_SUBJECTS_CAP = 20;
const UNASSIGNED_CLUSTER_ID = -1;

const SUBJECT_NOISE_TOKENS = new Set([
  // articles, prepositions, conjunctions
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'up', 'and', 'or', 'but', 'not', 'no', 'is', 'it', 'as', 'if',
  'be', 'so', 'do', 'we', 'all', 'its', 'was', 'are', 'has', 'had', 'been',
  'this', 'that', 'into', 'when', 'more', 'some',
  // common commit verbs & prefixes
  'add', 'fix', 'update', 'remove', 'delete', 'change', 'move', 'rename',
  'refactor', 'clean', 'cleanup', 'merge', 'revert', 'bump', 'set', 'use',
  'make', 'wip', 'pr', 'cr',
  // conventional commit prefixes (stripped before tokenization too)
  'feat', 'chore', 'docs', 'style', 'test', 'ci', 'build', 'perf',
]);

/* ── Cluster assignment ───────────────────────────────────────────── */

function assignCommitsToClusters(
  commits: CommitFileInput[],
  fileRisks: ArchobsRiskInput[],
): Map<number, CommitFileInput[]> {
  const pathToCluster = new Map<string, number>();
  for (const fr of fileRisks) {
    pathToCluster.set(fr.path, fr.cluster_id);
  }

  const grouped = new Map<number, CommitFileInput[]>();
  for (const commit of commits) {
    const clusterId = pathToCluster.get(commit.path) ?? UNASSIGNED_CLUSTER_ID;
    let list = grouped.get(clusterId);
    if (!list) {
      list = [];
      grouped.set(clusterId, list);
    }
    list.push(commit);
  }

  return grouped;
}

/* ── Velocity classification ──────────────────────────────────────── */

function classifyVelocity(
  olderHalf: number,
  newerHalf: number,
  total: number,
): 'accelerating' | 'steady' | 'decelerating' | 'dormant' {
  if (total < VELOCITY_DORMANT_THRESHOLD) return 'dormant';
  if (newerHalf > olderHalf * VELOCITY_ACCELERATION_RATIO) return 'accelerating';
  if (olderHalf > newerHalf * VELOCITY_ACCELERATION_RATIO) return 'decelerating';
  return 'steady';
}

/* ── Per-cluster trajectory ───────────────────────────────────────── */

function computeClusterTrajectory(
  clusterId: number,
  commits: CommitFileInput[],
  clusterInfo: ArchobsClusterInput | undefined,
  windowStart: number,
  windowEnd: number,
): ClusterTrajectory {
  let additions = 0;
  let modifications = 0;
  let deletions = 0;

  for (const c of commits) {
    switch (c.status) {
      case 'A': additions++; break;
      case 'M': modifications++; break;
      case 'D': deletions++; break;
    }
  }

  const total_changes = additions + modifications + deletions;
  const growth_ratio = total_changes > 0 ? additions / total_changes : 0;
  const churn_ratio = total_changes > 0 ? modifications / total_changes : 0;
  const contraction_ratio = total_changes > 0 ? deletions / total_changes : 0;

  // Distinct commits in window
  const commitShas = new Set(commits.map((c) => c.commit_sha));
  const recent_commits = commitShas.size;

  // Velocity: split window at midpoint, count distinct commits per half
  const midpoint = (windowStart + windowEnd) / 2;
  const olderShas = new Set<string>();
  const newerShas = new Set<string>();
  for (const c of commits) {
    if (c.commit_ts <= midpoint) olderShas.add(c.commit_sha);
    else newerShas.add(c.commit_sha);
  }
  const olderHalf = olderShas.size;
  const newerHalf = newerShas.size;
  const velocity_trend = classifyVelocity(olderHalf, newerHalf, recent_commits);

  // recently_added_paths: status='A', sorted by commit_ts desc, deduped
  const addedPaths: string[] = [];
  const addedSeen = new Set<string>();
  const addedEntries = commits
    .filter((c) => c.status === 'A')
    .sort((a, b) => b.commit_ts - a.commit_ts);
  for (const c of addedEntries) {
    if (!addedSeen.has(c.path)) {
      addedSeen.add(c.path);
      addedPaths.push(c.path);
    }
  }

  // most_modified_paths: status='M', count by path, sorted by count desc, top 10
  const modCounts = new Map<string, number>();
  for (const c of commits) {
    if (c.status === 'M') {
      modCounts.set(c.path, (modCounts.get(c.path) ?? 0) + 1);
    }
  }
  const most_modified_paths = [...modCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_MODIFIED_PATHS_CAP)
    .map(([path]) => path);

  // recently_deleted_paths: status='D', sorted by commit_ts desc, deduped
  const deletedPaths: string[] = [];
  const deletedSeen = new Set<string>();
  const deletedEntries = commits
    .filter((c) => c.status === 'D')
    .sort((a, b) => b.commit_ts - a.commit_ts);
  for (const c of deletedEntries) {
    if (!deletedSeen.has(c.path)) {
      deletedSeen.add(c.path);
      deletedPaths.push(c.path);
    }
  }

  const result: ClusterTrajectory = {
    cluster_id: clusterId,
    top_paths: clusterInfo?.top_paths ?? [],
    total_changes,
    additions,
    modifications,
    deletions,
    growth_ratio,
    churn_ratio,
    contraction_ratio,
    recent_commits,
    velocity_trend,
    velocity_halves: [olderHalf, newerHalf],
    recently_added_paths: addedPaths,
    most_modified_paths,
    recently_deleted_paths: deletedPaths,
  };

  if (clusterInfo) {
    result.archobs = {
      leakage: clusterInfo.leakage,
      cohesion: clusterInfo.cohesion,
      risk_mean: clusterInfo.risk_mean,
      risk_max: clusterInfo.risk_max,
    };
  }

  return result;
}

/* ── Momentum and concentration ───────────────────────────────────── */

function computeMomentum(
  clusterChangeCounts: Map<number, number>,
  totalChanges: number,
): { momentum: ClusterMomentum[]; concentration_index: number } {
  if (totalChanges === 0) {
    const momentum: ClusterMomentum[] = [...clusterChangeCounts.keys()].map((id) => ({
      cluster_id: id,
      share_of_changes: 0,
      rank: 1,
    }));
    return { momentum, concentration_index: 0 };
  }

  const entries = [...clusterChangeCounts.entries()]
    .map(([cluster_id, count]) => ({
      cluster_id,
      share_of_changes: count / totalChanges,
    }))
    .sort((a, b) => b.share_of_changes - a.share_of_changes);

  const momentum: ClusterMomentum[] = entries.map((e, i) => ({
    cluster_id: e.cluster_id,
    share_of_changes: e.share_of_changes,
    rank: i + 1,
  }));

  const concentration_index = entries.reduce((sum, e) => sum + e.share_of_changes ** 2, 0);

  return { momentum, concentration_index };
}

/* ── Subject pattern extraction ───────────────────────────────────── */

function extractSubjectPatterns(
  messages: CommitMessageInput[],
  topN: number = TOP_SUBJECT_TOKENS,
): SubjectPatterns {
  const tokenCounts = new Map<string, number>();

  for (const msg of messages) {
    // Strip conventional commit prefix (e.g. "feat:", "fix(scope):")
    const cleaned = msg.subject.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '');
    const tokens = cleaned
      .split(/[\s/\-_.,;:!?()[\]{}"'`#]+/)
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 1 && !SUBJECT_NOISE_TOKENS.has(t));

    for (const token of tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  const top_tokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([token, count]) => ({ token, count }));

  const recent_subjects = messages
    .slice(-RECENT_SUBJECTS_CAP)
    .reverse()
    .map((m) => m.subject);

  return { top_tokens, recent_subjects };
}

/* ── Main entry ───────────────────────────────────────────────────── */

export function computeTrajectory(input: TrajectoryInput): TrajectoryData {
  const windowDays = input.window_days ?? DEFAULT_WINDOW_DAYS;

  // Find the most recent commit timestamp to anchor the window
  let maxTs = 0;
  for (const c of input.commits) {
    if (c.commit_ts > maxTs) maxTs = c.commit_ts;
  }

  if (maxTs === 0) {
    // No commits — return empty structure
    return {
      window: { start_ts: 0, end_ts: 0, total_commits: 0, total_file_changes: 0 },
      clusters: [],
      momentum: [],
      concentration_index: 0,
    };
  }

  const windowStart = maxTs - windowDays * 86400;
  const windowEnd = maxTs;

  // Filter commits to window
  const filtered = input.commits.filter((c) => c.commit_ts >= windowStart);

  // Count distinct commits in window
  const distinctShas = new Set(filtered.map((c) => c.commit_sha));

  // Assign commits to clusters
  const grouped = assignCommitsToClusters(filtered, input.file_risks ?? []);

  // Build cluster info lookup
  const clusterInfoMap = new Map<number, ArchobsClusterInput>();
  for (const cluster of input.clusters) {
    clusterInfoMap.set(cluster.cluster_id, cluster);
  }

  // Compute per-cluster trajectories
  const clusterTrajectories: ClusterTrajectory[] = [];
  const clusterChangeCounts = new Map<number, number>();

  for (const [clusterId, commits] of grouped) {
    const trajectory = computeClusterTrajectory(
      clusterId,
      commits,
      clusterInfoMap.get(clusterId),
      windowStart,
      windowEnd,
    );
    clusterTrajectories.push(trajectory);
    clusterChangeCounts.set(clusterId, trajectory.total_changes);
  }

  // Sort clusters by total_changes descending for readability
  clusterTrajectories.sort((a, b) => b.total_changes - a.total_changes);

  // Compute momentum and concentration
  const { momentum, concentration_index } = computeMomentum(
    clusterChangeCounts,
    filtered.length,
  );

  // Extract subject patterns if commit_messages provided
  let subject_patterns: SubjectPatterns | undefined;
  if (input.commit_messages && input.commit_messages.length > 0) {
    // Filter to messages within window, sort by commit_ts (oldest first for slice/reverse)
    const shaToTs = new Map<string, number>();
    for (const c of filtered) {
      const existing = shaToTs.get(c.commit_sha);
      if (existing === undefined || c.commit_ts > existing) {
        shaToTs.set(c.commit_sha, c.commit_ts);
      }
    }
    const windowMessages = input.commit_messages
      .filter((m) => shaToTs.has(m.commit_sha))
      .sort((a, b) => (shaToTs.get(a.commit_sha) ?? 0) - (shaToTs.get(b.commit_sha) ?? 0));
    if (windowMessages.length > 0) {
      subject_patterns = extractSubjectPatterns(windowMessages);
    }
  }

  return {
    window: {
      start_ts: windowStart,
      end_ts: windowEnd,
      total_commits: distinctShas.size,
      total_file_changes: filtered.length,
    },
    clusters: clusterTrajectories,
    momentum,
    concentration_index,
    subject_patterns,
  };
}
