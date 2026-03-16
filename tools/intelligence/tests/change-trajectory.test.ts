import { describe, it, expect } from 'vitest';
import { computeTrajectory } from '../src/queries/change-trajectory.js';
import type {
  CommitFileInput,
  CommitMessageInput,
  TrajectoryInput,
} from '../src/queries/change-trajectory.js';
import type {
  ArchobsClusterInput,
  ArchobsRiskInput,
} from '../src/queries/risk-intelligence.js';

/* ── Test fixtures ─────────────────────────────────────────────────── */

const BASE_TS = 1710000000; // ~2024-03-09

function makeCommit(overrides: Partial<CommitFileInput> = {}): CommitFileInput {
  return {
    commit_sha: 'abc123',
    commit_ts: BASE_TS,
    status: 'A',
    path: 'src/feature/file.ts',
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

function makeFileRisk(overrides: Partial<ArchobsRiskInput> & { path: string; cluster_id: number }): ArchobsRiskInput {
  return {
    risk: 0.30,
    xnbr: 4,
    hubness: 0.20,
    volatility: 0.10,
    ...overrides,
  };
}

/* ── Empty input ───────────────────────────────────────────────────── */

describe('empty input', () => {
  it('returns empty trajectory with zero totals for no commits', () => {
    const result = computeTrajectory({
      commits: [],
      clusters: [makeCluster({ cluster_id: 0 })],
    });

    expect(result.window.total_commits).toBe(0);
    expect(result.window.total_file_changes).toBe(0);
    expect(result.clusters).toEqual([]);
    expect(result.momentum).toEqual([]);
    expect(result.concentration_index).toBe(0);
    expect(result.subject_patterns).toBeUndefined();
  });
});

/* ── Single cluster additions ──────────────────────────────────────── */

describe('single cluster additions', () => {
  it('all status=A results in growth_ratio=1.0, churn/contraction=0', () => {
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'a1', path: 'src/exports/csv.ts', status: 'A', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'a2', path: 'src/exports/pdf.ts', status: 'A', commit_ts: BASE_TS + 100 }),
      makeCommit({ commit_sha: 'a3', path: 'src/exports/json.ts', status: 'A', commit_ts: BASE_TS + 200 }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/exports/csv.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/exports/pdf.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/exports/json.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
    });

    expect(result.clusters).toHaveLength(1);
    const c = result.clusters[0];
    expect(c.cluster_id).toBe(0);
    expect(c.growth_ratio).toBe(1.0);
    expect(c.churn_ratio).toBe(0);
    expect(c.contraction_ratio).toBe(0);
    expect(c.additions).toBe(3);
    expect(c.modifications).toBe(0);
    expect(c.deletions).toBe(0);
  });
});

/* ── Status breakdown: mix of A/M/D ───────────────────────────────── */

describe('status breakdown', () => {
  it('correctly counts and computes ratios for mixed A/M/D', () => {
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'a1', path: 'src/a.ts', status: 'A', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'a2', path: 'src/b.ts', status: 'A', commit_ts: BASE_TS + 100 }),
      makeCommit({ commit_sha: 'a3', path: 'src/c.ts', status: 'M', commit_ts: BASE_TS + 200 }),
      makeCommit({ commit_sha: 'a4', path: 'src/c.ts', status: 'M', commit_ts: BASE_TS + 300 }),
      makeCommit({ commit_sha: 'a5', path: 'src/c.ts', status: 'M', commit_ts: BASE_TS + 400 }),
      makeCommit({ commit_sha: 'a6', path: 'src/d.ts', status: 'D', commit_ts: BASE_TS + 500 }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/a.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/b.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/c.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/d.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
    });

    const c = result.clusters[0];
    expect(c.additions).toBe(2);
    expect(c.modifications).toBe(3);
    expect(c.deletions).toBe(1);
    expect(c.total_changes).toBe(6);
    expect(c.growth_ratio).toBeCloseTo(2 / 6);
    expect(c.churn_ratio).toBeCloseTo(3 / 6);
    expect(c.contraction_ratio).toBeCloseTo(1 / 6);
  });
});

/* ── Concentrated changes ──────────────────────────────────────────── */

describe('concentrated changes', () => {
  it('90% in one cluster yields high concentration_index and rank=1', () => {
    const commits: CommitFileInput[] = [];
    // 9 commits in cluster 0
    for (let i = 0; i < 9; i++) {
      commits.push(makeCommit({
        commit_sha: `c${i}`,
        path: `src/main/file${i}.ts`,
        status: 'M',
        commit_ts: BASE_TS + i * 100,
      }));
    }
    // 1 commit in cluster 1
    commits.push(makeCommit({
      commit_sha: 'c9',
      path: 'src/other/x.ts',
      status: 'M',
      commit_ts: BASE_TS + 900,
    }));

    const fileRisks: ArchobsRiskInput[] = [];
    for (let i = 0; i < 9; i++) {
      fileRisks.push(makeFileRisk({ path: `src/main/file${i}.ts`, cluster_id: 0 }));
    }
    fileRisks.push(makeFileRisk({ path: 'src/other/x.ts', cluster_id: 1 }));

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 }), makeCluster({ cluster_id: 1 })],
      file_risks: fileRisks,
    });

    // Concentration: 0.9^2 + 0.1^2 = 0.82
    expect(result.concentration_index).toBeCloseTo(0.82);

    const rank1 = result.momentum.find((m) => m.rank === 1);
    expect(rank1).toBeDefined();
    expect(rank1!.cluster_id).toBe(0);
    expect(rank1!.share_of_changes).toBeCloseTo(0.9);
  });
});

/* ── Velocity classification ───────────────────────────────────────── */

describe('velocity classification', () => {
  it('more recent commits than older → accelerating', () => {
    // Window: BASE_TS - 30*86400 to BASE_TS
    // Midpoint: BASE_TS - 15*86400
    const windowDays = 30;
    const midpoint = BASE_TS - 15 * 86400;
    const commits: CommitFileInput[] = [
      // 1 commit in older half
      makeCommit({ commit_sha: 'old1', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 1000 }),
      // 4 commits in newer half
      makeCommit({ commit_sha: 'new1', path: 'src/a.ts', status: 'M', commit_ts: midpoint + 1000 }),
      makeCommit({ commit_sha: 'new2', path: 'src/a.ts', status: 'M', commit_ts: midpoint + 2000 }),
      makeCommit({ commit_sha: 'new3', path: 'src/a.ts', status: 'M', commit_ts: midpoint + 3000 }),
      makeCommit({ commit_sha: 'new4', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/a.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
      window_days: windowDays,
    });

    const c = result.clusters[0];
    expect(c.velocity_trend).toBe('accelerating');
    expect(c.velocity_halves[1]).toBeGreaterThan(c.velocity_halves[0]);
  });

  it('more older commits than recent → decelerating', () => {
    const windowDays = 30;
    const midpoint = BASE_TS - 15 * 86400;
    const commits: CommitFileInput[] = [
      // 4 commits in older half
      makeCommit({ commit_sha: 'old1', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 4000 }),
      makeCommit({ commit_sha: 'old2', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 3000 }),
      makeCommit({ commit_sha: 'old3', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 2000 }),
      makeCommit({ commit_sha: 'old4', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 1000 }),
      // 1 commit in newer half
      makeCommit({ commit_sha: 'new1', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/a.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
      window_days: windowDays,
    });

    const c = result.clusters[0];
    expect(c.velocity_trend).toBe('decelerating');
    expect(c.velocity_halves[0]).toBeGreaterThan(c.velocity_halves[1]);
  });

  it('balanced distribution → steady', () => {
    const windowDays = 30;
    const midpoint = BASE_TS - 15 * 86400;
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'old1', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 2000 }),
      makeCommit({ commit_sha: 'old2', path: 'src/a.ts', status: 'M', commit_ts: midpoint - 1000 }),
      makeCommit({ commit_sha: 'new1', path: 'src/a.ts', status: 'M', commit_ts: midpoint + 1000 }),
      makeCommit({ commit_sha: 'new2', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/a.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
      window_days: windowDays,
    });

    expect(result.clusters[0].velocity_trend).toBe('steady');
  });

  it('fewer than 3 total commits → dormant', () => {
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'a1', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'a2', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS - 1000 }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/a.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
    });

    expect(result.clusters[0].velocity_trend).toBe('dormant');
  });
});

/* ── Unknown paths ─────────────────────────────────────────────────── */

describe('unknown paths', () => {
  it('commits for files not in file_risks are assigned to cluster_id=-1', () => {
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'a1', path: 'src/unknown/new-file.ts', status: 'A', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'a2', path: 'src/known/file.ts', status: 'M', commit_ts: BASE_TS }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/known/file.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
    });

    const unknownCluster = result.clusters.find((c) => c.cluster_id === -1);
    expect(unknownCluster).toBeDefined();
    expect(unknownCluster!.additions).toBe(1);
    expect(unknownCluster!.recently_added_paths).toContain('src/unknown/new-file.ts');
  });
});

/* ── Window filtering ──────────────────────────────────────────────── */

describe('window filtering', () => {
  it('commits outside window_days are excluded', () => {
    const commits: CommitFileInput[] = [
      // Within 7-day window (relative to most recent commit)
      makeCommit({ commit_sha: 'recent', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'recent2', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS - 3 * 86400 }),
      // Outside 7-day window
      makeCommit({ commit_sha: 'old', path: 'src/a.ts', status: 'A', commit_ts: BASE_TS - 10 * 86400 }),
    ];
    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/a.ts', cluster_id: 0 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      file_risks: fileRisks,
      window_days: 7,
    });

    expect(result.window.total_commits).toBe(2);
    expect(result.window.total_file_changes).toBe(2);
    // The old commit with status 'A' should be excluded
    const c = result.clusters[0];
    expect(c.additions).toBe(0);
    expect(c.modifications).toBe(2);
  });
});

/* ── Subject patterns ──────────────────────────────────────────────── */

describe('subject patterns', () => {
  it('populates top_tokens and recent_subjects when commit_messages provided', () => {
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'a1', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'a2', path: 'src/a.ts', status: 'A', commit_ts: BASE_TS - 1000 }),
      makeCommit({ commit_sha: 'a3', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS - 2000 }),
    ];
    const commitMessages: CommitMessageInput[] = [
      { commit_sha: 'a1', subject: 'feat: add CSV export handler' },
      { commit_sha: 'a2', subject: 'feat: add PDF export template' },
      { commit_sha: 'a3', subject: 'fix: export filename sanitization' },
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
      commit_messages: commitMessages,
    });

    expect(result.subject_patterns).toBeDefined();
    expect(result.subject_patterns!.top_tokens.length).toBeGreaterThan(0);

    // 'export' appears in all 3 messages
    const exportToken = result.subject_patterns!.top_tokens.find((t) => t.token === 'export');
    expect(exportToken).toBeDefined();
    expect(exportToken!.count).toBe(3);

    expect(result.subject_patterns!.recent_subjects).toHaveLength(3);
    // Most recent first
    expect(result.subject_patterns!.recent_subjects[0]).toBe('feat: add CSV export handler');
  });

  it('subject_patterns is undefined when no commit_messages provided', () => {
    const commits: CommitFileInput[] = [
      makeCommit({ commit_sha: 'a1', path: 'src/a.ts', status: 'M', commit_ts: BASE_TS }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
    });

    expect(result.subject_patterns).toBeUndefined();
  });
});

/* ── Path lists ────────────────────────────────────────────────────── */

describe('path lists', () => {
  it('recently_added sorted by recency, most_modified by count', () => {
    const commits: CommitFileInput[] = [
      // Additions at different times
      makeCommit({ commit_sha: 'a1', path: 'src/first.ts', status: 'A', commit_ts: BASE_TS - 3000 }),
      makeCommit({ commit_sha: 'a2', path: 'src/second.ts', status: 'A', commit_ts: BASE_TS - 2000 }),
      makeCommit({ commit_sha: 'a3', path: 'src/third.ts', status: 'A', commit_ts: BASE_TS - 1000 }),
      // Modifications with different counts
      makeCommit({ commit_sha: 'm1', path: 'src/hot.ts', status: 'M', commit_ts: BASE_TS }),
      makeCommit({ commit_sha: 'm2', path: 'src/hot.ts', status: 'M', commit_ts: BASE_TS - 500 }),
      makeCommit({ commit_sha: 'm3', path: 'src/hot.ts', status: 'M', commit_ts: BASE_TS - 1500 }),
      makeCommit({ commit_sha: 'm4', path: 'src/warm.ts', status: 'M', commit_ts: BASE_TS - 200 }),
    ];

    const result = computeTrajectory({
      commits,
      clusters: [makeCluster({ cluster_id: 0 })],
    });

    const c = result.clusters[0];

    // recently_added: newest first
    expect(c.recently_added_paths[0]).toBe('src/third.ts');
    expect(c.recently_added_paths[1]).toBe('src/second.ts');
    expect(c.recently_added_paths[2]).toBe('src/first.ts');

    // most_modified: highest count first
    expect(c.most_modified_paths[0]).toBe('src/hot.ts');
    expect(c.most_modified_paths[1]).toBe('src/warm.ts');
  });
});

/* ── Integration: full computeTrajectory ───────────────────────────── */

describe('integration: full computeTrajectory', () => {
  it('produces complete output structure with realistic mock data', () => {
    const windowDays = 30;
    const now = BASE_TS;
    const midpoint = now - 15 * 86400;

    const commits: CommitFileInput[] = [
      // Cluster 0: export features (growing, accelerating)
      makeCommit({ commit_sha: 'e1', path: 'src/exports/csv.ts', status: 'A', commit_ts: midpoint + 86400 }),
      makeCommit({ commit_sha: 'e2', path: 'src/exports/pdf.ts', status: 'A', commit_ts: midpoint + 2 * 86400 }),
      makeCommit({ commit_sha: 'e3', path: 'src/exports/json.ts', status: 'A', commit_ts: midpoint + 3 * 86400 }),
      makeCommit({ commit_sha: 'e4', path: 'src/exports/csv.ts', status: 'M', commit_ts: midpoint + 4 * 86400 }),
      makeCommit({ commit_sha: 'e5', path: 'src/exports/template.ts', status: 'A', commit_ts: now }),
      makeCommit({ commit_sha: 'e0', path: 'src/exports/base.ts', status: 'M', commit_ts: midpoint - 86400 }),

      // Cluster 1: auth (steady, mostly modifications)
      makeCommit({ commit_sha: 'auth1', path: 'src/auth/login.ts', status: 'M', commit_ts: midpoint - 2 * 86400 }),
      makeCommit({ commit_sha: 'auth2', path: 'src/auth/session.ts', status: 'M', commit_ts: midpoint + 86400 }),
      makeCommit({ commit_sha: 'auth3', path: 'src/auth/logout.ts', status: 'M', commit_ts: now - 86400 }),

      // Cluster 2: legacy (contracting)
      makeCommit({ commit_sha: 'd1', path: 'src/legacy/old-api.ts', status: 'D', commit_ts: now - 2 * 86400 }),
      makeCommit({ commit_sha: 'd2', path: 'src/legacy/compat.ts', status: 'D', commit_ts: now - 86400 }),
    ];

    const clusters: ArchobsClusterInput[] = [
      makeCluster({ cluster_id: 0, top_paths: ['src/exports/csv.ts', 'src/exports/pdf.ts'], leakage: 0.05, cohesion: 0.9 }),
      makeCluster({ cluster_id: 1, top_paths: ['src/auth/login.ts', 'src/auth/session.ts'], leakage: 0.15, risk_max: 0.6 }),
      makeCluster({ cluster_id: 2, top_paths: ['src/legacy/old-api.ts'], leakage: 0.30, risk_max: 0.7 }),
    ];

    const fileRisks: ArchobsRiskInput[] = [
      makeFileRisk({ path: 'src/exports/csv.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/exports/pdf.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/exports/json.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/exports/base.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/exports/template.ts', cluster_id: 0 }),
      makeFileRisk({ path: 'src/auth/login.ts', cluster_id: 1 }),
      makeFileRisk({ path: 'src/auth/session.ts', cluster_id: 1 }),
      makeFileRisk({ path: 'src/auth/logout.ts', cluster_id: 1 }),
      makeFileRisk({ path: 'src/legacy/old-api.ts', cluster_id: 2 }),
      makeFileRisk({ path: 'src/legacy/compat.ts', cluster_id: 2 }),
    ];

    const commitMessages: CommitMessageInput[] = [
      { commit_sha: 'e1', subject: 'feat: add CSV export' },
      { commit_sha: 'e2', subject: 'feat: add PDF export' },
      { commit_sha: 'e3', subject: 'feat: add JSON export' },
      { commit_sha: 'e4', subject: 'fix: CSV export encoding' },
      { commit_sha: 'e5', subject: 'feat: add export template engine' },
      { commit_sha: 'e0', subject: 'refactor: export base class' },
      { commit_sha: 'auth1', subject: 'fix: login token refresh' },
      { commit_sha: 'auth2', subject: 'fix: session expiry handling' },
      { commit_sha: 'auth3', subject: 'fix: logout redirect' },
      { commit_sha: 'd1', subject: 'chore: remove deprecated API' },
      { commit_sha: 'd2', subject: 'chore: remove legacy compat layer' },
    ];

    const result = computeTrajectory({
      commits,
      clusters,
      file_risks: fileRisks,
      commit_messages: commitMessages,
      window_days: windowDays,
    });

    // Window
    expect(result.window.total_commits).toBeGreaterThan(0);
    expect(result.window.total_file_changes).toBe(11);

    // Clusters present
    expect(result.clusters.length).toBe(3);

    // Cluster 0 (exports) should be dominant
    const exports = result.clusters.find((c) => c.cluster_id === 0)!;
    expect(exports).toBeDefined();
    expect(exports.additions).toBe(4);
    expect(exports.modifications).toBe(2);
    expect(exports.growth_ratio).toBeCloseTo(4 / 6);
    expect(exports.archobs).toBeDefined();
    expect(exports.archobs!.leakage).toBe(0.05);
    expect(exports.recently_added_paths.length).toBeGreaterThan(0);

    // Cluster 1 (auth) should be all modifications
    const auth = result.clusters.find((c) => c.cluster_id === 1)!;
    expect(auth).toBeDefined();
    expect(auth.churn_ratio).toBe(1.0);

    // Cluster 2 (legacy) should be all deletions
    const legacy = result.clusters.find((c) => c.cluster_id === 2)!;
    expect(legacy).toBeDefined();
    expect(legacy.contraction_ratio).toBe(1.0);
    expect(legacy.recently_deleted_paths.length).toBe(2);

    // Momentum
    expect(result.momentum.length).toBe(3);
    const topMomentum = result.momentum.find((m) => m.rank === 1)!;
    expect(topMomentum.cluster_id).toBe(0); // exports is most active

    // Concentration index (not perfectly concentrated)
    expect(result.concentration_index).toBeGreaterThan(0);
    expect(result.concentration_index).toBeLessThan(1);

    // Subject patterns
    expect(result.subject_patterns).toBeDefined();
    const exportToken = result.subject_patterns!.top_tokens.find((t) => t.token === 'export');
    expect(exportToken).toBeDefined();
    expect(exportToken!.count).toBeGreaterThanOrEqual(4);
    expect(result.subject_patterns!.recent_subjects.length).toBeGreaterThan(0);
  });
});
