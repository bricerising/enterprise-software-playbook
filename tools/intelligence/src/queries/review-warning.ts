import type Database from 'better-sqlite3';

/**
 * Check whether a topic review is overdue (>90 days since last completed).
 * Returns a warning string if overdue or no review on record, null otherwise.
 *
 * Gracefully handles missing `tool_metadata` table (reader connections
 * don't run migrations).
 */
export function checkTopicReviewWarning(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(
        `SELECT value FROM tool_metadata WHERE key = 'topic_review_last_completed'`,
      )
      .get() as { value: string } | undefined;

    if (!row) {
      return 'No topic review on record. Run `intel topics audit --mark-reviewed` after completing a quarterly review.';
    }

    const lastReview = new Date(row.value);
    const now = new Date();
    const daysSince = Math.floor(
      (now.getTime() - lastReview.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysSince > 90) {
      return `Topic review overdue: last completed ${daysSince} days ago (${row.value}). Run \`intel topics audit\` to review.`;
    }

    return null;
  } catch {
    // Graceful fallback: table may not exist (reader connections don't run migrations)
    return null;
  }
}
