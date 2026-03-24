/**
 * Platt scaling — sigmoid calibration for raw classifier scores.
 *
 * Fits two parameters (A, B) via Newton's method so that:
 *   P(y=1 | score) = 1 / (1 + exp(A * score + B))
 *
 * This maps uncalibrated CNB log-odds to proper probabilities.
 */

export interface SigmoidParams {
  a: number;
  b: number;
}

/**
 * Fit Platt scaling sigmoid parameters from raw scores and binary labels.
 * Uses Newton's method (Platt 1999, Lin et al. 2007 improved algorithm).
 */
export function fitPlatt(
  scores: number[],
  labels: boolean[],
  maxIter = 100,
  minStep = 1e-10,
  sigma = 1e-12,
): SigmoidParams {
  if (scores.length !== labels.length || scores.length === 0) {
    return { a: 0, b: 0 };
  }

  const n = scores.length;

  // Target probabilities with Bayesian priors (avoids 0/1 targets)
  const nPos = labels.filter((l) => l).length;
  const nNeg = n - nPos;
  const hiTarget = (nPos + 1) / (nPos + 2);
  const loTarget = 1 / (nNeg + 2);

  const target = labels.map((l) => (l ? hiTarget : loTarget));

  // Initial parameters
  let a = 0;
  let b = Math.log((nNeg + 1) / (nPos + 1));
  let fval = 0;

  // Initialize function value
  for (let i = 0; i < n; i++) {
    const fApB = a * scores[i] + b;
    if (fApB >= 0) {
      fval += target[i] * fApB + Math.log(1 + Math.exp(-fApB));
    } else {
      fval += (target[i] - 1) * fApB + Math.log(1 + Math.exp(fApB));
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    // Compute Hessian & gradient
    let h11 = sigma;
    let h22 = sigma;
    let h21 = 0;
    let g1 = 0;
    let g2 = 0;

    for (let i = 0; i < n; i++) {
      const fApB = a * scores[i] + b;
      let p: number;
      let q: number;
      if (fApB >= 0) {
        p = Math.exp(-fApB) / (1 + Math.exp(-fApB));
        q = 1 / (1 + Math.exp(-fApB));
      } else {
        p = 1 / (1 + Math.exp(fApB));
        q = Math.exp(fApB) / (1 + Math.exp(fApB));
      }
      const d2 = p * q;
      h11 += scores[i] * scores[i] * d2;
      h22 += d2;
      h21 += scores[i] * d2;
      const d1 = target[i] - p;
      g1 += scores[i] * d1;
      g2 += d1;
    }

    // Prevent singular Hessian
    if (Math.abs(h11 * h22 - h21 * h21) < 1e-15) {
      break;
    }

    const det = h11 * h22 - h21 * h21;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    const gd = g1 * dA + g2 * dB;

    // Line search with Armijo condition
    let stepSize = 1;
    while (stepSize >= minStep) {
      const newA = a + stepSize * dA;
      const newB = b + stepSize * dB;
      let newF = 0;

      for (let i = 0; i < n; i++) {
        const fApB = newA * scores[i] + newB;
        if (fApB >= 0) {
          newF += target[i] * fApB + Math.log(1 + Math.exp(-fApB));
        } else {
          newF += (target[i] - 1) * fApB + Math.log(1 + Math.exp(fApB));
        }
      }

      if (newF < fval + 0.0001 * stepSize * gd) {
        a = newA;
        b = newB;
        fval = newF;
        break;
      }

      stepSize /= 2;
    }

    if (stepSize < minStep) {
      break;
    }

    // Check convergence
    if (Math.abs(g1) < 1e-5 && Math.abs(g2) < 1e-5) {
      break;
    }
  }

  return { a, b };
}

/**
 * Apply Platt sigmoid calibration.
 * Returns: 1 / (1 + exp(A * score + B))
 */
export function calibrate(score: number, params: SigmoidParams): number {
  const x = params.a * score + params.b;
  if (x >= 0) {
    return Math.exp(-x) / (1 + Math.exp(-x));
  }
  return 1 / (1 + Math.exp(x));
}
