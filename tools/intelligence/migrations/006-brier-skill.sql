-- Add base_rate and brier_ref to forecast_outcomes for Brier Skill Score.
-- Skill = 1 - brier/brier_ref normalizes scores against a naive base-rate
-- predictor, preventing high-base-rate topics from getting structurally
-- favorable weights. Existing evaluated rows keep brier_score but get NULL
-- for new columns (fallback to raw Brier in weight computation).

ALTER TABLE forecast_outcomes ADD COLUMN base_rate REAL;
ALTER TABLE forecast_outcomes ADD COLUMN brier_ref REAL;
