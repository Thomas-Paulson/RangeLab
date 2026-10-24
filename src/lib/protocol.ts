export type LinkStats = { raw: string; values: number[]; updatedAt: number };
export type TelemetryState = {
  channels: number[];
  channelUpdatedAt: number | null;
  link: LinkStats | null;
  statusLines: string[];
  rawLines: string[];
  lastLineAt: number | null;
};

export const EMPTY_TELEMETRY: TelemetryState = {
  channels: Array.from({ length: 16 }, () => 1500),
  channelUpdatedAt: null,
  link: null,
  statusLines: [],
  rawLines: [],
  lastLineAt: null,
};

function strictNumbers(parts: string[]): number[] | null {
  const values = parts.map(part => part.trim());
  if (values.some(value => value === '')) return null;
  const parsed = values.map(Number);
  if (parsed.some(value => !Number.isFinite(value))) return null;
  return parsed;
}

function parseChannels(parts: string[]): number[] | null {
  const values = strictNumbers(parts);
  if (!values) return null;

  let channels: number[];
  // Supported bridge formats:
  // CH,<16 values>
  // CH,16,<16 values>
  // CH,<index,value> repeated 16 times (index may be 0- or 1-based)
  if (values.length === 17 && values[0] === 16) {
    channels = values.slice(1);
  } else if (values.length === 32) {
    const pairs = Array.from({ length: 16 }, (_, i) => [values[i * 2], values[i * 2 + 1]]);
    const zeroBased = pairs.every(([index], i) => index === i);
    const oneBased = pairs.every(([index], i) => index === i + 1);
    if (!zeroBased && !oneBased) return null;
    channels = pairs.map(([, value]) => value);
  } else if (values.length === 16) {
    channels = values;
  } else {
    return null;
  }

  // Reject corrupted or non-pulse data rather than shifting channels silently.
  if (channels.some(value => !Number.isInteger(value) || value < 500 || value > 2500)) return null;
  return channels;
}

/** Parses the ASCII bridge format emitted by the ESP32 monitor sketch. */
export function applySerialLine(state: TelemetryState, raw: string): TelemetryState {
  const line = raw.trim();
  if (!line) return state;
  const now = Date.now();
  const upper = line.toUpperCase();
  const rawLines = [...state.rawLines, line].slice(-500);

  if (upper.startsWith('CH,')) {
    const channels = parseChannels(line.split(',').slice(1));
    if (!channels) return { ...state, rawLines, lastLineAt: now };
    return { ...state, channels, channelUpdatedAt: now, rawLines, lastLineAt: now };
  }
  if (upper.startsWith('LINK,')) {
    const values = strictNumbers(line.split(',').slice(1));
    if (!values) return { ...state, rawLines, lastLineAt: now };
    return { ...state, link: { raw: line, values, updatedAt: now }, rawLines, lastLineAt: now };
  }
  if (upper.startsWith('STATUS,')) {
    const statusLines = [...state.statusLines, line.slice(7).trim()].slice(-80);
    return { ...state, statusLines, rawLines, lastLineAt: now };
  }
  return { ...state, rawLines, lastLineAt: now };
}

export function pulseLabel(value: number): string {
  if (value < 900) return 'LOW';
  if (value > 2100) return 'HIGH';
  if (value >= 1450 && value <= 1550) return 'CENTRE';
  return 'ACTIVE';
}
