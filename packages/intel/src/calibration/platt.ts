/**
 * Platt scaling — the calibration map from *stated* probability to *corrected*
 * probability, fitted on our own resolved history.
 *
 * Two parameters only. That is the point: isotonic regression overfits badly
 * below a few hundred points, and we will have ~100–250 resolved forecasts in
 * year one. Two parameters is what that much data can honestly support.
 *
 * Corrected probabilities are shown in the UI; raw stays in the DB.
 */
import { clampP, type ResolvedForecast } from './scoring.js';

export interface PlattModel {
  a: number;
  b: number;
  /** How many resolved forecasts it was fitted on — displayed, never hidden. */
  n: number;
}

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Below this, a fitted curve is noise. Callers must fall back to identity. */
export const MIN_FIT_SAMPLES = 100;

export const identityModel = (n = 0): PlattModel => ({ a: 1, b: 0, n });

/**
 * Fit `sigmoid(a·logit(p) + b)` by gradient descent on log loss.
 *
 * Returns the identity map when there is not enough data, or when the outcomes
 * are all one class (nothing to calibrate against) — silently returning a
 * confident-looking curve there would be worse than doing nothing.
 */
export function fitPlatt(fs: ReadonlyArray<ResolvedForecast>, iterations = 2000): PlattModel {
  if (fs.length < MIN_FIT_SAMPLES) return identityModel(fs.length);

  const positives = fs.reduce((acc, f) => acc + f.outcome, 0);
  if (positives === 0 || positives === fs.length) return identityModel(fs.length);

  const xs = fs.map((f) => logit(clampP(f.p)));
  const ys = fs.map((f) => f.outcome);

  let a = 1;
  let b = 0;
  const lr = 0.05;

  for (let it = 0; it < iterations; it++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const err = sigmoid(a * x + b) - ys[i]!;
      ga += err * x;
      gb += err;
    }
    a -= (lr * ga) / xs.length;
    b -= (lr * gb) / xs.length;
  }
  return { a, b, n: fs.length };
}

/** Apply the map. Always clamped, so a corrected value is never 0 or 1. */
export function applyPlatt(model: PlattModel, p: number): number {
  return clampP(sigmoid(model.a * logit(clampP(p)) + model.b));
}
