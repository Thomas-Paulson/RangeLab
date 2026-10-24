export type Preset = { name: string; min: number; mid: number; max: number; notes: string };

export const isValidRange = (min: number, mid: number, max: number): boolean =>
  Number.isInteger(min) && Number.isInteger(mid) && Number.isInteger(max) &&
  min >= 750 && min <= 1250 && mid >= 1250 && mid <= 1750 && max >= 1750 && max <= 2250 &&
  min < mid && mid < max;

export function validPreset(value: unknown): value is Preset {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 80 &&
    isValidRange(item.min as number, item.mid as number, item.max as number);
}

/** Accept either a RangeLab export object or a raw array of profiles. */
export function parseImportedProfiles(text: string): Preset[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  const candidate = Array.isArray(parsed) ? parsed :
    (parsed && typeof parsed === 'object' && 'profiles' in parsed ? (parsed as { profiles: unknown }).profiles : null);
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 100) {
    throw new Error('Expected a JSON array of profiles or a RangeLab export containing a profiles array (1–100 profiles).');
  }

  const imported: Preset[] = [];
  for (const value of candidate) {
    if (!value || typeof value !== 'object') throw new Error('One of the profiles is not an object.');
    const item = value as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const { min, mid, max } = item;
    if (!name || name.length > 80 || !isValidRange(min as number, mid as number, max as number)) {
      throw new Error('A profile has an invalid name or pulse range. Use whole-number values within the supported field limits and minimum < centre < maximum.');
    }
    imported.push({
      name,
      min: min as number,
      mid: mid as number,
      max: max as number,
      notes: typeof item.notes === 'string' ? item.notes.slice(0, 500) : 'Imported profile.',
    });
  }
  return [...new Map(imported.map(profile => [profile.name, profile] as const)).values()];
}
