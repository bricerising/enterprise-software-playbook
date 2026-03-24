"""Team metrics: author distribution, bus factor, and knowledge concentration."""

from __future__ import annotations

import pandas as pd


def compute_author_stats(
    commits_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
) -> pd.DataFrame:
    """Per-cluster author distribution: commit count, file count, pct of cluster.

    Returns DataFrame with columns:
        cluster_id, author, commit_count, file_count, pct_of_cluster
    """
    if commits_df.empty or file_metrics_df.empty or "author" not in commits_df.columns:
        return pd.DataFrame(
            columns=["cluster_id", "author", "commit_count", "file_count", "pct_of_cluster"]
        )

    path_cluster = file_metrics_df[["path", "cluster_id"]].drop_duplicates("path")
    merged = commits_df.merge(path_cluster, on="path", how="inner")

    if merged.empty:
        return pd.DataFrame(
            columns=["cluster_id", "author", "commit_count", "file_count", "pct_of_cluster"]
        )

    stats = (
        merged.groupby(["cluster_id", "author"], as_index=False)
        .agg(
            commit_count=("commit_sha", "nunique"),
            file_count=("path", "nunique"),
        )
    )

    # Compute cluster totals for percentage
    cluster_totals = (
        stats.groupby("cluster_id", as_index=False)["commit_count"]
        .sum()
        .rename(columns={"commit_count": "cluster_total"})
    )
    stats = stats.merge(cluster_totals, on="cluster_id", how="left")
    stats["pct_of_cluster"] = (stats["commit_count"] / stats["cluster_total"]).round(4)
    stats = stats.drop(columns=["cluster_total"])

    return stats.sort_values(["cluster_id", "commit_count"], ascending=[True, False]).reset_index(drop=True)


def compute_bus_factor(
    author_stats_df: pd.DataFrame,
    threshold: float = 0.8,
) -> pd.DataFrame:
    """Min authors covering threshold% of commits per cluster.

    Returns DataFrame with columns:
        cluster_id, bus_factor, top_author, top_author_pct
    """
    if author_stats_df.empty:
        return pd.DataFrame(
            columns=["cluster_id", "bus_factor", "top_author", "top_author_pct"]
        )

    rows: list[dict[str, object]] = []
    for cluster_id, group in author_stats_df.groupby("cluster_id"):
        sorted_group = group.sort_values("pct_of_cluster", ascending=False)
        cumulative = 0.0
        count = 0
        for _, row in sorted_group.iterrows():
            cumulative += float(row["pct_of_cluster"])
            count += 1
            if cumulative >= threshold:
                break

        top = sorted_group.iloc[0]
        rows.append({
            "cluster_id": cluster_id,
            "bus_factor": count,
            "top_author": str(top["author"]),
            "top_author_pct": round(float(top["pct_of_cluster"]), 4),
        })

    return pd.DataFrame(rows).sort_values("cluster_id").reset_index(drop=True)


def compute_knowledge_concentration(
    author_stats_df: pd.DataFrame,
) -> pd.DataFrame:
    """Herfindahl-Hirschman Index per cluster (0=dispersed, 1=monopoly).

    Returns DataFrame with columns:
        cluster_id, hhi, author_count
    """
    if author_stats_df.empty:
        return pd.DataFrame(columns=["cluster_id", "hhi", "author_count"])

    rows: list[dict[str, object]] = []
    for cluster_id, group in author_stats_df.groupby("cluster_id"):
        hhi = float((group["pct_of_cluster"] ** 2).sum())
        rows.append({
            "cluster_id": cluster_id,
            "hhi": round(hhi, 4),
            "author_count": len(group),
        })

    return pd.DataFrame(rows).sort_values("cluster_id").reset_index(drop=True)
