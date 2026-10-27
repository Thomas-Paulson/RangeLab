export const CURVE_POINTS = 5;

export type Mode = 'OFF' | 'SERVO' | 'PWM' | 'DIGITAL' | 'WINDOW' | 'CURVE';

/** Evenly spaced curve outputs across the input range (inMin..inMax). */
export type Curve = number[];

export const DEFAULT_CURVE: Curve = [1000, 1250, 1500, 1750, 2000];

/** Output-range defaults per mode. DIGITAL is fixed by the firmware at the input midpoint. */
export const DIGITAL_RANGE = { outLow: 0, outHigh: 1 } as const;
export const PWM_RANGE = { outLow: 0, outHigh: 255 } as const;
export const SERVO_RANGE = { outLow: 1000, outHigh: 2000 } as const;
/** WINDOW drives a band rather than a travel, so it defaults to a centred band. */
export const WINDOW_BAND = { outLow: 1450, outHigh: 1550 } as const;

type Range = { outLow: number; outHigh: number };

/** True for a duty range that can actually dim an output: within 0–255 and wider than the digital 0–1 pair. */
export function isPwmRange(r: Range): boolean {
  return Number.isInteger(r.outLow) && Number.isInteger(r.outHigh)
    && r.outLow >= 0 && r.outHigh <= 255 && r.outLow < r.outHigh && r.outHigh > DIGITAL_RANGE.outHigh;
}

/** True for a microcontroller pulse (travel) range in microseconds. */
export function isPulseRange(r: Range): boolean {
  return Number.isInteger(r.outLow) && Number.isInteger(r.outHigh)
    && r.outLow >= 500 && r.outHigh <= 2500 && r.outLow < r.outHigh;
}

/**
 * Output range to use after the mode selector changes to `mode`. Values that are already
 * meaningful on the new mode's scale are kept; anything else falls back to that mode's own
 * range. Without this, DIGITAL's fixed 0–1 range survives into PWM, where the saved mapping
 * drives ~0.4% duty and the LED stays almost invisible at full travel.
 */
export function outputRangeForMode(mode: Mode, current: Range): Range {
  switch (mode) {
    case 'PWM':
      return isPwmRange(current) ? { outLow: current.outLow, outHigh: current.outHigh } : { ...PWM_RANGE };
    case 'SERVO':
    case 'CURVE':
      return isPulseRange(current) ? { outLow: current.outLow, outHigh: current.outHigh } : { ...SERVO_RANGE };
    case 'WINDOW':
      // A band spanning the whole travel would hold the output high permanently.
      return isPulseRange(current) && current.outHigh - current.outLow <= 500
        ? { outLow: current.outLow, outHigh: current.outHigh }
        : { ...WINDOW_BAND };
    case 'DIGITAL':
      return { ...DIGITAL_RANGE };
    default:
      return { outLow: current.outLow, outHigh: current.outHigh };
  }
}

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
  if (m.mode === 'PWM') {
    if (m.outLow < 0 || m.outHigh > 255 || m.outLow >= m.outHigh) return 'PWM range must be 0–255, low below high';
    // A 0–1 span passes the bounds check but is a leftover digital range: ~0.4% duty at full travel.
    if (m.outHigh <= DIGITAL_RANGE.outHigh) return 'PWM range spans only 0–1, about 0.4% duty at full travel. Set a range within 0–255, for example 0–255.';
  }
  if (m.mode === 'CURVE') {
    if (m.curve.length !== CURVE_POINTS) return `Curve needs ${CURVE_POINTS} points`;
    if (m.curve.some(v => !Number.isInteger(v) || v < 500 || v > 2500)) return 'Curve points must be 500–2500 µs';
  }
  return null;
}
