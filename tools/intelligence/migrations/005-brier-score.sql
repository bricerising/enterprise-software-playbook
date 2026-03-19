-- Replace binary TP/FP evaluation with Brier score for calibration-aware
-- forecast learning. Brier score = (predicted_probability - outcome)^2
-- measures how well-calibrated predictions are: 0 = perfect, 1 = worst.
--
-- The previous binary TP/FP approach counted all observed spikes as true
-- positives regardless of predicted probability, causing high-base-rate
-- topics to accumulate TPs trivially and inflating their weights.

ALTER TABLE forecast_outcomes ADD COLUMN brier_score REAL;

ALTER TABLE topic_weights ADD COLUMN avg_brier_score REAL;
