export const CURVE_POINTS = 5;

export type Mode = 'OFF' | 'SERVO' | 'PWM' | 'DIGITAL' | 'WINDOW' | 'CURVE';

/** Evenly spaced curve outputs across the input range (inMin..inMax). */
export type Curve = number[];

export const DEFAULT_CURVE: Curve = [1000, 1250, 1500, 1750, 2000];

/** Returns true when the input lies inside the window [inMin, inMax] (inclusive). */
export function inWindow(value: number, inMin: number, inMax: number): boolean {
  return value >= inMin && value <= inMax;
}

/** Linear interpolation of a multi-point curve. Inputs outside the range clamp to end points. */
export function evaluateCurve(value: number, inMin: number, inMax: number, curve: Curve): number {
  if (curve.length < 2) return curve[0] ?? 0;
  const span = inMax - inMin;
  if (span <= 0) return curve[0];
  const t = Math.min(1, Math.max(0, (value - inMin) / span)) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(t));
  const f = t - i;
  return curve[i] + (curve[i + 1] - curve[i]) * f;
}

export type MappingLike = { inMin: number; inMax: number; mode: Mode; pin: number; outLow: number; outHigh: number; curve: Curve };

/** Validates one channel mapping. Returns an error message, or null when valid. */
export function validateMapping(m: MappingLike, safePins: readonly number[]): string | null {
  if (!Number.isInteger(m.inMin) || !Number.isInteger(m.inMax)) return 'Input range must be whole microseconds';
  if (m.inMin < 500 || m.inMax > 2500 || m.inMin >= m.inMax) return 'Input range must be 500–2500 µs with minimum below maximum';
  if (m.mode === 'OFF') return null;
  if (!safePins.includes(m.pin)) return 'GPIO is not on the safe-pin list';
  if (m.mode === 'SERVO' && (m.outLow < 500 || m.outHigh > 2500 || m.outLow >= m.outHigh)) return 'Servo output must be 500–2500 µs, low below high';
  if (m.mode === 'PWM' && (m.outLow < 0 || m.outHigh > 255 || m.outLow >= m.outHigh)) return 'PWM range must be 0–255, low below high';
  if (m.mode === 'CURVE') {
    if (m.curve.length !== CURVE_POINTS) return `Curve needs ${CURVE_POINTS} points`;
    if (m.curve.some(v => !Number.isInteger(v) || v < 500 || v > 2500)) return 'Curve points must be 500–2500 µs';
  }
  return null;
}
