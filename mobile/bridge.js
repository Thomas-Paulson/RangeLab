// RangeLab mobile bridge protocol helpers.
//
// DOM-free and dependency-free so the Node test suite can exercise exactly the
// code the phone runs. The firmware on this branch mirrors the same line
// protocol it prints over USB, so these helpers are the mobile twin of
// src/lib/protocol.ts (that one is TypeScript for the desktop bundle; this one
// ships straight to the phone with no build step).

export const CHANNEL_COUNT = 16;
export const MAX_EVENTS = 200;
export const SAFE_PINS = [13, 14, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
export const MODES = ['OFF', 'SERVO', 'PWM', 'DIGITAL', 'WINDOW', 'CURVE'];
export const DEFAULT_CURVE = [1000, 1250, 1500, 1750, 2000];

export function emptyMapping(ch) {
  return {
    ch,
    inMin: 1000,
    inMax: 2000,
    mode: 'OFF',
    pin: -1,
    outLow: 1000,
    outHigh: 2000,
    curve: [...DEFAULT_CURVE],
  };
}

export function createState() {
  return {
    channels: Array.from({ length: CHANNEL_COUNT }, () => 1500),
    channelUpdatedAt: null,
    link: null,
    device: '',
    outputsEnabled: false,
    controlsUnlocked: false,
    mappings: Array.from({ length: CHANNEL_COUNT }, (_, i) => emptyMapping(i + 1)),
    events: [],
    eventDraft: null,
    eventsVersion: 0,
    logs: ['Waiting for the ESP32 WiFi bridge.'],
    lineCount: 0,
    lastLineAt: null,
  };
}

/** Splits a WebSocket chunk stream into complete lines, keeping the partial tail. */
export function splitLines(buffer, chunk) {
  const parts = (buffer + chunk).split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts.filter(line => line.length > 0), rest: rest.length > 8192 ? '' : rest };
}

function strictNumbers(parts) {
  const values = parts.map(part => part.trim());
  if (values.some(value => value === '')) return null;
  const parsed = values.map(Number);
  if (parsed.some(value => !Number.isFinite(value))) return null;
  return parsed;
}

function parseChannels(parts) {
  const values = strictNumbers(parts);
  if (!values) return null;
  // The bridge emits CH,<16 values>; tolerate the indexed forms the desktop
  // parser also accepts so older monitor sketches keep working.
  let channels;
  if (values.length === 17 && values[0] === 16) channels = values.slice(1);
  else if (values.length === 32) {
    const pairs = Array.from({ length: 16 }, (_, i) => [values[i * 2], values[i * 2 + 1]]);
    const zeroBased = pairs.every(([index], i) => index === i);
    const oneBased = pairs.every(([index], i) => index === i + 1);
    if (!zeroBased && !oneBased) return null;
    channels = pairs.map(([, value]) => value);
  } else if (values.length === 16) channels = values;
  else return null;
  if (channels.some(value => !Number.isInteger(value) || value < 500 || value > 2500)) return null;
  return channels;
}

function withLog(state, text) {
  return [...state.logs, text].slice(-120);
}

/** Applies one newline-free protocol line to the UI state. */
export function applyLine(state, raw) {
  const line = (raw ?? '').trim();
  if (!line) return state;
  const now = Date.now();
  const base = { ...state, lastLineAt: now, lineCount: state.lineCount + 1 };
  const upper = line.toUpperCase();

  if (upper.startsWith('CH,')) {
    const channels = parseChannels(line.split(',').slice(1));
    if (!channels) return base;
    return { ...base, channels, channelUpdatedAt: now };
  }
  if (upper.startsWith('LINK,')) {
    const values = strictNumbers(line.split(',').slice(1));
    if (!values) return base;
    return { ...base, link: { rssi: values[0], lq: values[1], snr: values[2] } };
  }
  if (upper.startsWith('CFG,')) {
    const p = line.split(',');
    if (p.length < 8) return base;
    const ch = Number(p[1]);
    if (!Number.isInteger(ch) || ch < 1 || ch > CHANNEL_COUNT) return base;
    const mapping = {
      ch,
      inMin: Number(p[2]),
      inMax: Number(p[3]),
      mode: String(p[4]).toUpperCase(),
      pin: Number(p[5]),
      outLow: Number(p[6]),
      outHigh: Number(p[7]),
      curve: p.length >= 13 ? p.slice(8, 13).map(Number) : [...DEFAULT_CURVE],
    };
    if (!MODES.includes(mapping.mode) || mapping.curve.some(v => !Number.isFinite(v))) return base;
    return { ...base, mappings: base.mappings.map(m => (m.ch === ch ? mapping : m)) };
  }
  if (upper.startsWith('STATUS,')) {
    const text = line.slice(7).trim();
    const next = { ...base, logs: withLog(base, text) };
    if (text === 'OUTPUTS_ENABLED') next.outputsEnabled = true;
    else if (text === 'OUTPUTS_DISABLED' || text === 'OUTPUTS_DISABLED_ON_BOOT') next.outputsEnabled = false;
    if (text === 'CONTROLS_UNLOCKED') next.controlsUnlocked = true;
    else if (text === 'CONTROLS_LOCKED' || text === 'CONTROLS_RELOCKED_IDLE') next.controlsUnlocked = false;
    if (text === 'EVENTS_CLEARED') {
      next.events = [];
      next.eventDraft = null;
      next.eventsVersion = base.eventsVersion + 1;
    }
    return next;
  }
  // The ESP32 keeps link/receiver trouble in flash. EVENTS replays it between
  // EVENT_DUMP_BEGIN and EVENT_END, and live events arrive as EVENT lines too.
  if (upper.startsWith('EVENT_DUMP_BEGIN')) {
    return { ...base, eventDraft: [], eventsVersion: base.eventsVersion + 1 };
  }
  if (upper.startsWith('EVENT_END')) {
    // An empty dump (no flash, or cleared) must not wipe live events already shown.
    const final = base.eventDraft && base.eventDraft.length ? base.eventDraft : base.events;
    return { ...base, events: final.slice(-MAX_EVENTS), eventDraft: null, eventsVersion: base.eventsVersion + 1 };
  }
  if (upper.startsWith('EVENT,')) {
    const parts = line.split(',');
    const at = Number(parts[1]);
    const code = String(parts[2] ?? '').trim().toUpperCase();
    if (!Number.isFinite(at) || !code) return base;
    const event = { at, code, detail: parts.slice(3).join(',').trim() };
    if (base.eventDraft) {
      return { ...base, eventDraft: base.eventDraft.concat(event).slice(-MAX_EVENTS), eventsVersion: base.eventsVersion + 1 };
    }
    return { ...base, events: base.events.concat(event).slice(-MAX_EVENTS), eventsVersion: base.eventsVersion + 1 };
  }
  if (upper.startsWith('DEVICE,')) return { ...base, device: line.split(',').slice(1).join(' ') };
  if (upper.startsWith('PONG,')) return { ...base, device: line.split(',').slice(1).join(' ') };
  if (upper.startsWith('READY,')) return { ...base, device: line.split(',').slice(1).join(' ') };
  if (upper.startsWith('LOG,')) {
    const body = line.slice(4);
    if (body.startsWith('END') || body.startsWith('SIZE')) return base;
    return { ...base, logs: withLog(base, body) };
  }
  return { ...base, logs: withLog(base, line) };
}

/** Validates one channel mapping against the same rules the firmware enforces. */
export function validateMapping(mapping, allMappings = []) {
  const m = mapping;
  if (!Number.isInteger(m.inMin) || !Number.isInteger(m.inMax)) {
    return { ok: false, error: 'Input range must be whole microseconds.' };
  }
  if (m.inMin < 500 || m.inMax > 2500) return { ok: false, error: 'Input range must stay inside 500–2500 µs.' };
  if (m.inMin >= m.inMax) return { ok: false, error: 'Input minimum must be below the maximum.' };
  if (!MODES.includes(m.mode)) return { ok: false, error: 'Unknown output mode.' };
  if (m.mode === 'OFF') return { ok: true };
  if (!SAFE_PINS.includes(m.pin)) return { ok: false, error: 'GPIO is not on the safe-pin list.' };
  if (m.mode === 'SERVO' && !(m.outLow >= 500 && m.outHigh <= 2500 && m.outLow < m.outHigh)) {
    return { ok: false, error: 'Servo output must be 500–2500 µs with low below high.' };
  }
  if (m.mode === 'PWM' && !(m.outLow >= 0 && m.outHigh <= 255 && m.outLow < m.outHigh)) {
    return { ok: false, error: 'PWM output must be 0–255 with low below high.' };
  }
  if (m.mode === 'WINDOW' && !(m.outLow >= 500 && m.outHigh <= 2500 && m.outLow < m.outHigh)) {
    return { ok: false, error: 'Window band must be 500–2500 µs with low below high.' };
  }
  if (m.mode === 'CURVE') {
    const curve = m.curve;
    if (!Array.isArray(curve) || curve.length !== 5 || curve.some(v => !Number.isInteger(v) || v < 500 || v > 2500)) {
      return { ok: false, error: 'Curve needs five whole points between 500 and 2500 µs.' };
    }
  }
  const clash = allMappings.find(o => o.ch !== m.ch && o.mode !== 'OFF' && o.pin === m.pin);
  if (clash) return { ok: false, error: `GPIO ${m.pin} is already assigned to channel ${clash.ch}.` };
  return { ok: true };
}

/** Builds the SET line the firmware expects, or reports why it was rejected. */
export function prepareMapping(mapping, allMappings = []) {
  const check = validateMapping(mapping, allMappings);
  if (!check.ok) return check;
  const m = mapping;
  const pin = m.mode === 'OFF' ? -1 : m.pin;
  const head = `SET,${m.ch},${m.inMin},${m.inMax},${m.mode},${pin},${m.outLow},${m.outHigh}`;
  return { ok: true, command: m.mode === 'CURVE' ? `${head},${m.curve.join(',')}` : head };
}

/** Meter fill for an 800–2200 µs sweep, clamped to 0–100. */
export function pulsePercent(value) {
  return Math.max(0, Math.min(100, ((Number(value) - 800) / 1400) * 100));
}
