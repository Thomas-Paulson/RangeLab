// Phone UI glue: WebSocket transport, rendering, and the mapping editor.
// All protocol parsing and validation lives in ./bridge.js so the Node tests
// cover it; this file only touches the DOM and the socket.

import {
  CHANNEL_COUNT,
  SAFE_PINS,
  applyLine,
  createState,
  prepareMapping,
  pulsePercent,
  splitLines,
} from './bridge.js';

const WS_PORT = 81;
const RETRY_MIN_MS = 700;
const RETRY_MAX_MS = 8000;

const el = (id) => document.getElementById(id);
let state = createState();
let socket = null;
let selected = 1;
let retryMs = RETRY_MIN_MS;
let rxBuffer = '';
let renderedLineCount = -1;
let renderedEventVersion = -1;
let renderedTraceVersion = -1;
let lastFrame = 0;
let enableArmedAt = 0;
let curveInputs = [];

// ---------- transport ----------

function socketUrl() {
  const host = location.hostname || '192.168.4.1';
  return `ws://${host}:${WS_PORT}/`;
}

function setPill(kind, text) {
  const pill = el('link-pill');
  pill.className = `pill ${kind}`.trim();
  el('link-text').textContent = text;
}

function push(text) {
  state = { ...state, logs: [...state.logs, text].slice(-120), lineCount: state.lineCount };
  renderedLineCount = -1;
}

function connect() {
  if (socket) {
    socket.onclose = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* already closed */ }
  }
  rxBuffer = '';
  setPill('warn', 'CONNECTING');
  let ws;
  try {
    ws = new WebSocket(socketUrl());
  } catch {
    setPill('', 'OFFLINE');
    push('Could not open the bridge socket. Is the phone still on the RangeLab WiFi?');
    return;
  }
  socket = ws;
  ws.onopen = () => {
    retryMs = RETRY_MIN_MS;
    setPill('good', 'CONNECTED');
    push('Bridge connected. Reading config and event log.');
    ws.send('GET');
    ws.send('EVENTS');
    ws.send('TRACE');
  };
  ws.onmessage = (event) => {
    const { lines, rest } = splitLines(rxBuffer, String(event.data));
    rxBuffer = rest;
    for (const line of lines) state = applyLine(state, line);
  };
  ws.onerror = () => { /* onclose handles recovery */ };
  ws.onclose = () => {
    setPill('', 'OFFLINE');
    socket = null;
    push('Bridge disconnected. Retrying…');
    setTimeout(connect, retryMs);
    retryMs = Math.min(Math.round(retryMs * 1.6), RETRY_MAX_MS);
  };
}

function send(line) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    push('Not connected — command not sent.');
    return false;
  }
  socket.send(line);
  push(`→ ${line}`);
  return true;
}

// ---------- render ----------

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildChannelRows() {
  const host = el('channels');
  host.innerHTML = '';
  for (let i = 0; i < CHANNEL_COUNT; i += 1) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.dataset.ch = String(i + 1);
    row.innerHTML = `<span class="n">CH ${String(i + 1).padStart(2, '0')}</span>
      <span class="bar"><i></i></span>
      <b>1500</b>
      <em>UNMAPPED</em>`;
    row.addEventListener('click', () => {
      selected = i + 1;
      syncSelection();
      loadEditor();
    });
    host.appendChild(row);
  }
}

const EVENT_BAD = new Set(['RX_SILENT', 'RF_LINK_LOST', 'RC_LOST', 'PWR_DIP', 'PWR_GLITCH', 'WIRE_NOISE', 'RX_RESTART']);
const EVENT_GOOD = new Set(['RX_ACTIVE', 'RF_LINK_OK', 'RC_OK', 'PWR_OK']);
// Matches RAIL_LOW_MV in the sketch; only used to colour the reading.
const RAIL_LOW_MV = 4600;

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(Number(ms)));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

// Timestamps are ESP32 uptime, so they restart with the board. Newest first.
function renderEvents() {
  if (state.eventsVersion === renderedEventVersion) return;
  renderedEventVersion = state.eventsVersion;
  el('event-count').textContent = String(state.events.length);
  const host = el('events');
  if (!state.events.length) {
    host.innerHTML = '<div class="ev empty">No events recorded yet.</div>';
    return;
  }
  host.innerHTML = state.events
    .slice()
    .reverse()
    .map((event) => {
      const kind = EVENT_BAD.has(event.code) ? 'bad' : EVENT_GOOD.has(event.code) ? 'good' : '';
      return `<div class="ev"><span>${formatUptime(event.at)}</span><b class="${kind}">${escapeHtml(event.code)}</b><em>${escapeHtml(event.detail)}</em></div>`;
    })
    .join('');
}

const TRACE_HEADER = '<div class="tr head"><span>t</span><span>RSSI A/B</span><span>LQ</span><span>SNR</span><span>ANT</span><span>MODE</span><span>TX</span></div>';

// Link statistics leading into the last drop, oldest first. A gentle RSSI slide
// is range/obstruction; LQ collapsing while RSSI holds is interference or loss.
function renderTrace() {
  if (state.traceVersion === renderedTraceVersion) return;
  renderedTraceVersion = state.traceVersion;
  const host = el('trace');
  if (!state.trace.length) {
    host.innerHTML = '<div class="ev empty">No link samples yet.</div>';
    return;
  }
  host.innerHTML = TRACE_HEADER + state.trace
    .map((p) => `<div class="tr"><span>${formatUptime(p.at)}</span><span>${p.rssi1}/${p.rssi2}</span>`
      + `<b class="${p.lq === 0 ? 'zero' : ''}">${p.lq}</b><span>${p.snr}</span>`
      + `<span>${p.ant}</span><span>${p.mode}</span><span>${p.txPwr}</span></div>`)
    .join('');
}

function render() {
  const now = Date.now();
  const signal = state.channelUpdatedAt !== null && now - state.channelUpdatedAt < 700;

  el('device').textContent = state.device || '—';
  el('link').textContent = state.link ? `${state.link.rssi} dBm · LQ ${state.link.lq}% · SNR ${state.link.snr}` : 'no link stats yet';
  el('receiver').textContent = signal ? 'frames received' : 'waiting for RC frames';
  const outputs = el('outputs');
  outputs.textContent = state.outputsEnabled ? 'ENABLED' : 'DISABLED';
  outputs.className = state.outputsEnabled ? 'on' : '';

  const railCell = el('rail');
  if (!state.rail) {
    railCell.textContent = 'not monitored';
    railCell.className = '';
  } else {
    const volts = (value) => `${(value / 1000).toFixed(2)} V`;
    railCell.textContent = `${volts(state.rail.mv)} · min ${volts(state.rail.minMv)}`;
    railCell.className = state.rail.minMv < RAIL_LOW_MV ? 'bad' : 'good';
  }

  // Counters since the board booted, so a wiggle test shows them climbing here.
  const wireCell = el('wire');
  if (!state.wire) {
    wireCell.textContent = 'waiting';
    wireCell.className = '';
  } else {
    const { bad, junk, ignored } = state.wire;
    const damaged = bad + junk;
    wireCell.textContent = damaged === 0
      ? (ignored ? `clean · ${ignored} ignored` : 'clean')
      : `${bad} bad · ${junk} sync`;
    wireCell.className = damaged === 0 ? 'good' : 'bad';
  }

  const rows = el('channels').children;
  for (let i = 0; i < rows.length; i += 1) {
    const value = state.channels[i] ?? 1500;
    const mapping = state.mappings[i];
    rows[i].querySelector('.bar i').style.width = `${pulsePercent(value)}%`;
    rows[i].querySelector('b').textContent = String(value);
    const tag = rows[i].querySelector('em');
    tag.textContent = mapping && mapping.mode !== 'OFF' ? `${mapping.mode} · GPIO ${mapping.pin}` : 'UNMAPPED';
    tag.className = mapping && mapping.mode !== 'OFF' ? 'live' : '';
  }

  el('unlock').textContent = state.controlsUnlocked ? 'Controls unlocked' : 'Unlock controls';
  el('unlock-note').textContent = state.controlsUnlocked
    ? 'Controls are unlocked for this session. Anyone on this WiFi can send commands until it relocks or the connection drops.'
    : 'Unlock before changing mappings or enabling outputs. Anyone connected to this WiFi network can send commands once unlocked.';
  el('enable').disabled = !state.controlsUnlocked;

  if (enableArmedAt && now - enableArmedAt > 5000) {
    enableArmedAt = 0;
    el('enable').textContent = 'Enable outputs';
  }

  renderEvents();
  renderTrace();

  if (state.lineCount !== renderedLineCount) {
    renderedLineCount = state.lineCount;
    const log = el('log');
    log.innerHTML = state.logs.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  // The socket state is the truth here: an unbound receiver simply sends no
  // frames, and the RECEIVER field already says so.
  if (socket && socket.readyState === WebSocket.OPEN) setPill('good', 'CONNECTED');
}

function tick() {
  const now = Date.now();
  if (!document.hidden && now - lastFrame > 90) {
    render();
    lastFrame = now;
  }
  requestAnimationFrame(tick);
}

// ---------- editor ----------

function buildEditorOptions() {
  const chSelect = el('f-ch');
  chSelect.innerHTML = Array.from({ length: CHANNEL_COUNT }, (_, i) => `<option value="${i + 1}">Channel ${i + 1}</option>`).join('');
  chSelect.value = String(selected);
  chSelect.addEventListener('change', () => {
    selected = Number(chSelect.value);
    syncSelection();
    loadEditor();
  });

  const pinSelect = el('f-pin');
  pinSelect.innerHTML = ['<option value="-1">None</option>']
    .concat(SAFE_PINS.map((pin) => `<option value="${pin}">GPIO ${pin}</option>`))
    .join('');

  const curveHost = el('curve-fields');
  curveInputs = Array.from({ length: 5 }, (_, i) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '500';
    input.max = '2500';
    input.step = '1';
    input.dataset.point = String(i);
    curveHost.appendChild(input);
    return input;
  });

  el('f-mode').addEventListener('change', syncModeFields);
}

function syncSelection() {
  el('editing').textContent = String(selected).padStart(2, '0');
  el('f-ch').value = String(selected);
  const rows = el('channels').children;
  for (let i = 0; i < rows.length; i += 1) rows[i].classList.toggle('sel', i + 1 === selected);
}

function loadEditor() {
  const mapping = state.mappings[selected - 1];
  el('f-inmin').value = String(mapping.inMin);
  el('f-inmax').value = String(mapping.inMax);
  el('f-mode').value = mapping.mode;
  el('f-pin').value = String(mapping.pin);
  el('f-outlow').value = String(mapping.outLow);
  el('f-outhigh').value = String(mapping.outHigh);
  curveInputs.forEach((input, i) => { input.value = String(mapping.curve[i] ?? 1000); });
  el('editor-msg').textContent = '';
  syncModeFields();
}

function syncModeFields() {
  const mode = el('f-mode').value;
  el('f-pin').disabled = mode === 'OFF';
  // CURVE maps µs to µs through its points, so a low/high pair does nothing there.
  el('out-range').classList.toggle('hidden', mode === 'OFF' || mode === 'DIGITAL' || mode === 'CURVE');
  el('curve-wrap').classList.toggle('hidden', mode !== 'CURVE');
  const labelLow = el('out-range').children[0];
  const labelHigh = el('out-range').children[1];
  if (mode === 'PWM') {
    labelLow.firstChild.textContent = 'Output low (0–255)';
    labelHigh.firstChild.textContent = 'Output high (0–255)';
  } else if (mode === 'WINDOW') {
    labelLow.firstChild.textContent = 'Band low (µs)';
    labelHigh.firstChild.textContent = 'Band high (µs)';
  } else {
    labelLow.firstChild.textContent = 'Output low';
    labelHigh.firstChild.textContent = 'Output high';
  }
}

function readEditor() {
  return {
    ch: selected,
    inMin: Number(el('f-inmin').value),
    inMax: Number(el('f-inmax').value),
    mode: el('f-mode').value,
    pin: Number(el('f-pin').value),
    outLow: Number(el('f-outlow').value),
    outHigh: Number(el('f-outhigh').value),
    curve: curveInputs.map((input) => Number(input.value)),
  };
}

function showEditorMessage(text, bad) {
  const node = el('editor-msg');
  node.textContent = text;
  node.className = bad ? 'msg bad' : 'msg';
}

function applyMapping() {
  if (!state.controlsUnlocked) {
    showEditorMessage('Unlock controls before writing a mapping.', true);
    return;
  }
  const result = prepareMapping(readEditor(), state.mappings);
  if (!result.ok) {
    showEditorMessage(result.error, true);
    return;
  }
  if (!send(result.command)) {
    showEditorMessage('Bridge is offline — mapping not sent.', true);
    return;
  }
  showEditorMessage('Sent. Waiting for the device to confirm…', false);
}

// ---------- wiring ----------

function wire() {
  buildChannelRows();
  buildEditorOptions();
  syncSelection();
  loadEditor();

  el('read-config').addEventListener('click', () => send('GET'));
  el('load-events').addEventListener('click', () => send('EVENTS'));
  el('load-trace').addEventListener('click', () => send('TRACE'));
  el('clear-events').addEventListener('click', () => {
    if (!state.controlsUnlocked) {
      push('Unlock controls before clearing the event log.');
      return;
    }
    send('EVENTS,CLEAR');
  });
  el('reconnect').addEventListener('click', () => { retryMs = RETRY_MIN_MS; connect(); });
  el('apply').addEventListener('click', applyMapping);

  el('disable-channel').addEventListener('click', () => {
    el('f-mode').value = 'OFF';
    el('f-pin').value = '-1';
    syncModeFields();
    applyMapping();
  });

  el('unlock').addEventListener('click', () => send('UNLOCK'));

  el('enable').addEventListener('click', () => {
    const now = Date.now();
    if (!enableArmedAt || now - enableArmedAt > 5000) {
      enableArmedAt = now;
      el('enable').textContent = 'Tap again to confirm';
      showEditorMessage('Second tap enables GPIO outputs. Check wiring and every mapping first.', false);
      return;
    }
    enableArmedAt = 0;
    el('enable').textContent = 'Enable outputs';
    send('ENABLE');
  });

  el('disable').addEventListener('click', () => send('DISABLE'));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket === null) connect();
  });

  window.addEventListener('beforeunload', () => {
    if (socket) { socket.onclose = null; socket.close(); }
  });
}

wire();
connect();
requestAnimationFrame(tick);
