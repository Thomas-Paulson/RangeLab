import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  Activity, Antenna, ArrowDownToLine, ArrowUpRight, AudioWaveform, BatteryCharging,
  BookOpen, Check, ChevronDown, CircleHelp, Code2, Command, Cpu, Download, FileCode2,
  Gauge, Gamepad2, Github, History, House, Keyboard, Link2, ListChecks, LoaderCircle,
  Menu, MoreHorizontal, Radio, RefreshCw, Save, Search, Send, Settings2, ShieldCheck,
  SlidersHorizontal, Sparkles, Terminal, Upload, Usb, Wifi, X, Zap, Play, Square,
} from 'lucide-react';
import { applySerialLine, EMPTY_TELEMETRY, pulseLabel, type TelemetryState } from './lib/protocol';
import { isValidRange, parseImportedProfiles, validPreset, type Preset } from './lib/profiles';
import { identifyFirmware } from './lib/firmware';

type Port = { name: string; kind: string };
type Page = 'Overview' | 'Receiver' | 'Ranges' | 'CLI Console' | 'Automation Lab' | 'Profiles' | 'Diagnostics';

const nav: { label: Page; icon: typeof House; group: string }[] = [
  { label: 'Overview', icon: House, group: 'WORKSPACE' },
  { label: 'Receiver', icon: Gamepad2, group: 'WORKSPACE' },
  { label: 'Ranges', icon: SlidersHorizontal, group: 'WORKSPACE' },
  { label: 'CLI Console', icon: Terminal, group: 'TOOLS' },
  { label: 'Automation Lab', icon: Code2, group: 'TOOLS' },
  { label: 'Profiles', icon: BookOpen, group: 'TOOLS' },
  { label: 'Diagnostics', icon: Activity, group: 'SYSTEM' },
];
const initialPresets: Preset[] = [
  { name: 'ESP-FC · Default', min: 885, mid: 1500, max: 2115, notes: 'Values recovered from the current ESP-FC CLI configuration.' },
  { name: 'Standard RC', min: 1000, mid: 1500, max: 2000, notes: 'Conventional 1000–2000 µs pulse range.' },
  { name: 'Extended endpoints', min: 885, mid: 1500, max: 2115, notes: 'Extended endpoints for compatible receiver/firmware setups.' },
];
const fmtTime = (value: number | null) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'No telemetry yet';
const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const isDestructiveCommand = (line: string) => /^\s*(save|reboot|defaults|erase|flash|dfu)(?:\s|$)/i.test(line);
function loadProfiles(): Preset[] {
  try {
    const stored = localStorage.getItem('rangelab-profiles-v1');
    if (!stored) return initialPresets;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return initialPresets;
    const valid = parsed.filter(validPreset).map(p => ({ ...p, name: p.name.trim(), notes: typeof p.notes === 'string' ? p.notes.slice(0, 500) : 'Saved profile.' }));
    return valid.length ? [...new Map(valid.map(p => [p.name, p] as const)).values()] : initialPresets;
  } catch { return initialPresets; }
}

function readStoredValue(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

export default function App() {
  const [page, setPage] = useState<Page>('Overview');
  const [ports, setPorts] = useState<Port[]>([]);
  const [portName, setPortName] = useState('');
  const [baud, setBaud] = useState(115200);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [clockTick, setClockTick] = useState(Date.now());
  const [desktop] = useState(isDesktop());
  const [telemetry, setTelemetry] = useState<TelemetryState>(EMPTY_TELEMETRY);
  const [consoleText, setConsoleText] = useState<string[]>(['RangeLab CLI ready.', 'Connect to your ESP32, then send a command. Type `help` to inspect supported firmware commands.']);
  const [firmwareEvidence, setFirmwareEvidence] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [commandDraft, setCommandDraft] = useState('');
  const [presetName, setPresetName] = useState('ESP-FC · Default');
  const [rangeMin, setRangeMin] = useState(885);
  const [rangeMid, setRangeMid] = useState(1500);
  const [rangeMax, setRangeMax] = useState(2115);
  const [savedProfiles, setSavedProfiles] = useState<Preset[]>(loadProfiles);
  const [macroName, setMacroName] = useState(() => readStoredValue('rangelab-macro-name', 'Read firmware info'));
  const [macroBody, setMacroBody] = useState(() => readStoredValue('rangelab-macro-body', 'version\nstatus\nget input_min\nget input_mid\nget input_max'));
  const [macroRunning, setMacroRunning] = useState(false);
  const macroCancelRequested = useRef(false);
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const consoleEnd = useRef<HTMLDivElement>(null);
  const profileFileInput = useRef<HTMLInputElement>(null);
  const serialBuffer = useRef('');
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  const refreshPorts = useCallback(async () => {
    if (!desktop) {
      setPorts([{ name: 'Native desktop required', kind: 'Open the packaged app for USB serial access' }]);
      return;
    }
    try {
      const found = await invoke<Port[]>('list_serial_ports');
      setPorts(found);
      if (found.length) setPortName(current => current || found[0].name);
    } catch (e) { notify(`Could not list serial ports: ${String(e)}`); }
  }, [desktop, notify]);

  useEffect(() => { void refreshPorts(); }, [refreshPorts]);
  useEffect(() => { const timer = window.setInterval(() => setClockTick(Date.now()), 500); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  // A completely isolated simulator lets people explore the UI and command workflow without hardware.
  useEffect(() => {
    if (!demoMode) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const t = (Date.now() - started) / 1000;
      const channels = [
        Math.round(1500 + Math.sin(t * 0.8) * 360),
        Math.round(1500 + Math.sin(t * 0.55 + 1.1) * 300),
        Math.round(1120 + (Math.sin(t * 0.22) + 1) * 120),
        Math.round(1500 + Math.sin(t * 0.32) * 420),
        1000 + (Math.floor(t / 7) % 2) * 1000,
        1000 + (Math.floor(t / 11) % 2) * 1000,
        1000 + (Math.floor(t / 17) % 2) * 1000,
        ...Array.from({ length: 8 }, (_, i) => Math.round(1500 + Math.sin(t * (0.12 + i * 0.025) + i) * 90)),
      ];
      const line = `CH,${channels.join(',')}`;
      setTelemetry(current => applySerialLine(current, line));
      if (Math.floor(t * 10) % 10 === 0) {
        setTelemetry(current => applySerialLine(current, `LINK,-${Math.round(55 + Math.abs(Math.sin(t)) * 18)},${Math.round(95 - Math.abs(Math.sin(t * .4)) * 8)},${Math.round(5 + Math.abs(Math.sin(t * .6)) * 4)}`));
      }
    }, 100);
    setConsoleText(current => [...current, '✓ Demo simulator started. No hardware is connected; commands are simulated locally.'].slice(-1000));
    return () => window.clearInterval(timer);
  }, [demoMode]);

  useEffect(() => {
    if (!desktop) return;
    let unlistenData: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;
    let alive = true;
    void listen<string>('serial-data', event => {
      if (!alive) return;
      const combined = serialBuffer.current + event.payload.replace(/\r/g, '');
      const chunks = combined.split('\n');
      serialBuffer.current = chunks.pop() ?? '';
      const completeLines = chunks.filter(Boolean);
      setTelemetry(current => completeLines.reduce((next, line) => applySerialLine(next, line), current));
      setConsoleText(current => [...current, ...completeLines.map(line => `← ${line}`)].slice(-1000));
      setFirmwareEvidence(current => [...current, ...completeLines.map(line => `← ${line}`)].slice(-200));
    }).then(fn => { unlistenData = fn; });
    void listen<string>('serial-error', event => {
      setConsoleText(current => [...current, `! ${event.payload}`].slice(-1000));
      setFirmwareEvidence([]);
      serialBuffer.current = '';
      setConnected(false);
      notify(`Serial error: ${event.payload}`);
    }).then(fn => { unlistenError = fn; });
    return () => { alive = false; unlistenData?.(); unlistenError?.(); };
  }, [desktop, notify]);

  useEffect(() => { consoleEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [consoleText]);
  useEffect(() => { try { localStorage.setItem('rangelab-profiles-v1', JSON.stringify(savedProfiles)); } catch { /* storage may be unavailable in a restricted web preview */ } }, [savedProfiles]);
  useEffect(() => { try { localStorage.setItem('rangelab-macro-name', macroName); localStorage.setItem('rangelab-macro-body', macroBody); } catch { /* storage may be unavailable in a restricted web preview */ } }, [macroName, macroBody]);

  const signalAge = telemetry.channelUpdatedAt ? clockTick - telemetry.channelUpdatedAt : null;
  const liveSignal = (connected || demoMode) && signalAge !== null && signalAge < 1500;
  const activeChannels = useMemo(() => telemetry.channels.filter(v => v < 1300 || v > 1700).length, [telemetry.channels]);
  const firmware = useMemo(() => identifyFirmware(firmwareEvidence), [firmwareEvidence]);

  function toggleDemo() {
    if (connected) { notify('Disconnect the real device before entering demo mode.'); return; }
    setFirmwareEvidence([]);
    setDemoMode(current => {
      const next = !current;
      if (!next) { setTelemetry(EMPTY_TELEMETRY); setConsoleText(lines => [...lines, '• Demo simulator stopped.'].slice(-1000)); }
      else { setPage('Overview'); }
      return next;
    });
    notify(demoMode ? 'Demo mode stopped' : 'Demo mode started. No hardware writes will occur.');
  }

  async function connect() {
    if (demoMode) { notify('Stop demo mode before connecting real hardware.'); return; }
    if (!desktop) { notify('USB serial is available in the native desktop build.'); return; }
    if (!portName || portName === 'Native desktop required') { notify('Select a serial port first.'); return; }
    setConnecting(true);
    try {
      serialBuffer.current = '';
      setFirmwareEvidence([]);
      await invoke('connect_serial', { portName, baudRate: baud });
      setConnected(true);
      setConsoleText(current => [...current, `✓ Connected to ${portName} at ${baud.toLocaleString()} baud.`]);
      notify('Serial connection opened');
    } catch (e) { notify(`Connection failed: ${String(e)}`); }
    finally { setConnecting(false); }
  }
  async function disconnect() {
    serialBuffer.current = '';
    setFirmwareEvidence([]);
    if (demoMode) { setDemoMode(false); }
    if (desktop) { try { await invoke('disconnect_serial'); } catch { /* already disconnected */ } }
    setConnected(false);
    setConsoleText(current => [...current, '• Disconnected.']);
  }
  async function sendRaw(text: string, alreadyConfirmed = false): Promise<boolean> {
    if (!text.trim()) return false;
    const commandLines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!demoMode && connected && !alreadyConfirmed && commandLines.some(isDestructiveCommand)) {
      const accepted = window.confirm('This command may save settings, reboot the controller, reset configuration, or alter firmware. Continue only if you understand the effect and have checked the connected device. Send it?');
      if (!accepted) { notify('Command cancelled. No command was sent.'); return false; }
    }
    if (demoMode) {
      const commands = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const replies: string[] = [];
      for (const cmd of commands) {
        setConsoleText(current => [...current, `→ ${cmd}`].slice(-1000));
        const lower = cmd.toLowerCase();
        if (lower === 'version') replies.push('ESPF ESP32 v0.2.1 DEMO · simulated response');
        else if (lower === 'status') replies.push('STATUS: DEMO MODE\ninput: 50 Hz, simulated CRSF receiver\narming flags: CLI (simulated)');
        else if (lower === 'stats') replies.push('rx_a: 50 Hz · rx_packets: simulated · failsafe: false');
        else if (lower === 'help') replies.push('help | version | status | stats | get <parameter> | set <parameter> <value> | save | reboot');
        else if (lower.startsWith('get input_min')) replies.push(`set input_min ${rangeMin}`);
        else if (lower.startsWith('get input_mid')) replies.push(`set input_mid ${rangeMid}`);
        else if (lower.startsWith('get input_max')) replies.push(`set input_max ${rangeMax}`);
        else if (lower.startsWith('get ')) replies.push(`Demo: parameter lookup simulated for ${cmd.slice(4)}.`);
        else if (lower.startsWith('set input_min ')) replies.push('Demo: minimum endpoint accepted locally.');
        else if (lower.startsWith('set input_mid ')) replies.push('Demo: centre endpoint accepted locally.');
        else if (lower.startsWith('set input_max ')) replies.push('Demo: maximum endpoint accepted locally.');
        else if (lower === 'save') replies.push('Demo: save acknowledged locally. No device was changed.');
        else if (lower === 'reboot') replies.push('Demo: reboot simulated.');
        else replies.push(`Demo: simulated response for “${cmd}”.`);
      }
      if (replies.length) {
        const received = replies.flatMap(r => r.split('\n').map(line => `← ${line}`));
        setConsoleText(current => [...current, ...received].slice(-1000));
        setFirmwareEvidence(current => [...current, ...received].slice(-200));
      }
      return true;
    }
    if (!connected || !desktop) { notify('Connect to a device or start the demo simulator.'); return false; }
    try {
      await invoke('write_serial', { data: text.endsWith('\n') ? text : `${text}\n` });
      setConsoleText(current => [...current, `→ ${text.trimEnd()}`].slice(-1000));
      return true;
    } catch (e) { notify(`Write failed: ${String(e)}`); return false; }
  }
  function sendCommand(e: FormEvent) {
    e.preventDefault();
    const next = command;
    if (next.trim()) {
      setCommandHistory(current => current.at(-1) === next.trim() ? current : [...current.slice(-99), next.trim()]);
    }
    setHistoryIndex(-1);
    setCommandDraft('');
    setCommand('');
    void sendRaw(next);
  }
  function navigateCommandHistory(key: string) {
    if (key === 'ArrowUp' && commandHistory.length) {
      const nextIndex = historyIndex < 0 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
      if (historyIndex < 0) setCommandDraft(command);
      setHistoryIndex(nextIndex);
      setCommand(commandHistory[nextIndex]);
      return true;
    }
    if (key === 'ArrowDown' && historyIndex >= 0) {
      if (historyIndex >= commandHistory.length - 1) {
        setHistoryIndex(-1);
        setCommand(commandDraft);
      } else {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setCommand(commandHistory[nextIndex]);
      }
      return true;
    }
    return false;
  }
  function selectPreset(name: string) {
    const preset = savedProfiles.find(p => p.name === name);
    if (!preset) return;
    setPresetName(name); setRangeMin(preset.min); setRangeMid(preset.mid); setRangeMax(preset.max);
  }
  function saveProfile() {
    if (!isValidRange(rangeMin, rangeMid, rangeMax)) {
      notify('Cannot save this profile: use whole-number pulse values with minimum < centre < maximum.');
      return;
    }
    const name = presetName.trim() || `Custom profile ${savedProfiles.length + 1}`;
    const next = { name, min: rangeMin, mid: rangeMid, max: rangeMax, notes: 'Saved from RangeLab.' };
    setSavedProfiles(current => [...current.filter(p => p.name !== name), next]);
    setPresetName(name);
    notify(`Saved profile: ${name}`);
  }
  async function importProfiles(file: File) {
    try {
      if (file.size > 1_000_000) throw new Error('Profile file is larger than 1 MB.');
      const unique = parseImportedProfiles(await file.text());
      setSavedProfiles(current => [...new Map([...current, ...unique].map(profile => [profile.name, profile] as const)).values()]);
      setPresetName(unique[0].name); setRangeMin(unique[0].min); setRangeMid(unique[0].mid); setRangeMax(unique[0].max);
      notify(`Imported ${unique.length} profile${unique.length === 1 ? '' : 's'}.`);
    } catch (error) {
      notify(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function exportProfile() {
    const data = { app: 'RangeLab', schemaVersion: 1, exportedAt: new Date().toISOString(), serial: { port: portName, baudRate: baud }, ranges: { min: rangeMin, mid: rangeMid, max: rangeMax }, profiles: savedProfiles };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'rangelab-profile.json'; a.click(); URL.revokeObjectURL(url);
    notify('Configuration exported as JSON');
  }
  async function applyRanges() {
    if (!isValidRange(rangeMin, rangeMid, rangeMax)) { notify('Use whole-number values within each field limit, with minimum < centre < maximum.'); return; }
    if (!demoMode && firmware.rangeCliSupported === false) {
      notify(`${firmware.label}: ESP-FC range commands were not sent.`);
      return;
    }
    if (!demoMode && connected && firmware.rangeCliSupported === 'unknown' && !window.confirm('RangeLab has not identified the connected firmware. These input_min/input_mid/input_max commands are specific to compatible ESP-FC builds. Send them anyway?')) {
      notify('Range changes cancelled. No commands were sent.');
      return;
    }
    if (demoMode) {
      setConsoleText(current => [...current, `→ set input_min ${rangeMin}`, `→ set input_mid ${rangeMid}`, `→ set input_max ${rangeMax}`, '← Demo: endpoint changes accepted locally. No hardware was changed.'].slice(-1000));
      notify('Range changes simulated only.'); setPage('CLI Console'); return;
    }
    if (!connected) { notify('Connect to ESP-FC before applying settings.'); return; }
    const commands = [`set input_min ${rangeMin}`, `set input_mid ${rangeMid}`, `set input_max ${rangeMax}`];
    let sent = 0;
    for (const line of commands) {
      const ok = await sendRaw(line, true);
      if (!ok) { notify(`Stopped after ${sent} of ${commands.length} range commands. Check the serial connection.`); return; }
      sent += 1;
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    notify('Three range commands sent individually. Check every CLI response before saving.');
    setPage('CLI Console');
  }
  async function runMacro() {
    const lines = macroBody.split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length) { notify('Add at least one command to the macro.'); return; }
    if (!connected && !demoMode) { notify('Connect to the device or start demo mode before running a macro.'); return; }
    if (lines.length > 100) { notify('Macros are limited to 100 commands per run.'); return; }
    const hasDestructive = lines.some(isDestructiveCommand);
    if (connected && hasDestructive && !window.confirm('This macro contains save/reboot/reset/firmware-altering commands. Review the full macro before continuing. Run the macro?')) {
      notify('Macro cancelled. No commands were sent.');
      return;
    }
    macroCancelRequested.current = false;
    setMacroRunning(true);
    let completed = 0;
    let sendFailed = false;
    try {
      for (const line of lines) {
        if (macroCancelRequested.current) break;
        const ok = await sendRaw(line, hasDestructive && connected);
        if (!ok) { sendFailed = true; break; }
        completed += 1;
        await new Promise(resolve => setTimeout(resolve, 180));
      }
    } finally {
      setMacroRunning(false);
    }
    if (macroCancelRequested.current) notify(`Macro stopped after ${completed} of ${lines.length} commands.`);
    else if (sendFailed) notify(`Macro halted after ${completed} commands because a command could not be sent.`);
    else notify(`Sent ${completed} command${completed === 1 ? '' : 's'}. Responses must still be checked in the console.`);
  }
  function clearConsole() { setConsoleText(['Console cleared.']); }
  function downloadLog() {
    const blob = new Blob([consoleText.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `rangelab-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`; a.click(); URL.revokeObjectURL(url);
  }

  const filteredNav = nav.filter(item => item.label.toLowerCase().includes(search.toLowerCase()));
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><AudioWaveform size={23} strokeWidth={2.4}/></div><div><div className="brand-name">Range<span>Lab</span></div><div className="brand-sub">ESP32 CONFIGURATION STUDIO</div></div><button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={18}/></button></div>
      <div className="device-card"><div className="device-top"><div className="device-icon"><Cpu size={18}/></div><span className={`status-dot ${connected || demoMode ? 'online' : ''}`}/></div><div className="device-name">{demoMode ? 'Virtual receiver' : 'ESP32 · WROOM'}</div><div className="device-meta">{connected ? portName : demoMode ? 'Local simulation' : 'No device connected'}</div><div className="device-footer"><span className={connected || demoMode ? 'connected-label' : ''}><span className="tiny-dot"/>{connected ? 'CONNECTED' : demoMode ? 'DEMO MODE' : 'STANDBY'}</span><span>{connected ? `${(baud / 1000).toFixed(0)}k baud` : demoMode ? 'SIMULATED' : 'USB SERIAL'}</span></div></div>
      <div className="nav-search"><Search size={15}/><input ref={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a tool..." aria-label="Find a tool"/><kbd>⌘ K</kbd></div>
      {['WORKSPACE', 'TOOLS', 'SYSTEM'].map(group => <div className="nav-group" key={group}><div className="nav-label">{group}</div>{filteredNav.filter(item => item.group === group).map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${page === item.label ? 'active' : ''}`} onClick={() => { setPage(item.label); setMenuOpen(false); }}><Icon size={17}/><span>{item.label}</span>{item.label === 'Receiver' && liveSignal && <i className="nav-live"/>}{item.label === 'Automation Lab' && <span className="nav-badge">BETA</span>}</button>; })}</div>)}
      <div className="sidebar-bottom"><div className="safe-card"><div className="safe-icon"><ShieldCheck size={17}/></div><div><strong>Local-first by design</strong><span>Serial data stays on this computer.</span></div></div><div className="sidebar-version"><span>RANGELAB PREVIEW</span><span>v0.1.0</span></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={19}/></button><div className="breadcrumb">RangeLab <span>/</span> <strong>{page}</strong></div></div><div className="topbar-actions"><div className="connection-pill"><span className={`pulse-dot ${connected || demoMode ? 'online' : ''}`}/><span>{connected ? 'Device connected' : demoMode ? 'Demo simulation' : 'Not connected'}</span></div><div className="connect-controls"><button className="secondary-button" onClick={toggleDemo} disabled={connected}>{demoMode ? <Square size={14}/> : <Play size={14}/>} {demoMode ? 'Stop demo' : 'Try demo'}</button><select aria-label="Serial port" value={portName} onChange={e => setPortName(e.target.value)} disabled={connected || demoMode || !desktop}><option value="">Select port</option>{ports.map(p => <option key={p.name} value={p.name}>{p.name}{p.kind && p.kind !== 'Unknown' ? ` · ${p.kind}` : ''}</option>)}</select><button className="refresh-button" onClick={() => void refreshPorts()} title="Refresh serial ports"><RefreshCw size={15}/></button>{connected ? <button className="disconnect-button" onClick={() => void disconnect()}>Disconnect</button> : <button className="connect-button" onClick={() => void connect()} disabled={connecting || !desktop || demoMode}>{connecting ? <LoaderCircle size={15} className="spin"/> : <Usb size={15}/>} Connect</button>}</div></div></header>
      {!desktop && <div className="browser-warning"><Usb size={16}/><div><strong>Native desktop mode required for USB serial.</strong><span>The interface preview works here, but direct serial access is enabled in the macOS/Windows desktop build.</span></div></div>}
      <div className="page-content">
        {page === 'Overview' && <>
          <section className="page-heading"><div><div className="eyebrow"><Sparkles size={13}/> FLIGHT CONTROL WORKBENCH</div><h1>Control room<span className="heading-period">.</span></h1><p>One place to inspect your receiver, tune ranges, and work directly with ESP32 firmware.</p></div><div className="heading-right"><span className="build-tag"><span className="tiny-dot"/> {connected ? 'LIVE SESSION' : demoMode ? 'SIMULATED SESSION' : 'READY WHEN YOU ARE'}</span><div className="last-seen"><History size={13}/>{fmtTime(telemetry.lastLineAt)}</div></div></section>
          <section className="metrics-grid"><Metric icon={Radio} label="Receiver link" value={liveSignal ? 'ACTIVE' : 'WAITING'} sub={liveSignal ? 'Channel stream detected' : 'Waiting for CH telemetry'} tone={liveSignal ? 'green' : 'neutral'}/><Metric icon={Gamepad2} label="Channels detected" value={telemetry.channelUpdatedAt ? `${telemetry.channels.length.toString().padStart(2, '0')} / 16` : '— / 16'} sub={telemetry.channelUpdatedAt ? `${activeChannels} channels away from centre` : 'No channel frames received'} tone="purple"/><Metric icon={Gauge} label="Pulse window" value={`${rangeMin}–${rangeMax}`} sub={`Centre at ${rangeMid} µs`} tone="blue"/><Metric icon={Link2} label="Serial transport" value={connected ? 'OPEN' : 'CLOSED'} sub={connected ? `${baud.toLocaleString()} baud · ${portName}` : 'USB serial not connected'} tone={connected ? 'green' : 'neutral'}/></section>
          <section className="overview-grid"><div className="panel receiver-panel"><PanelTitle icon={Activity} title="Receiver monitor" subtitle="Live channel activity" action={<button className="text-action" onClick={() => setPage('Receiver')}>Open monitor <ArrowUpRight size={14}/></button>}/><div className="receiver-summary"><div className="summary-main"><span className="summary-number">{telemetry.channelUpdatedAt ? telemetry.channels.length : '—'}</span><span className="summary-label">CHANNELS</span></div><div className="summary-divider"/><div className="summary-mini"><span>Last frame</span><strong>{fmtTime(telemetry.channelUpdatedAt)}</strong></div><div className="summary-mini"><span>Signal</span><strong className={liveSignal ? 'green-text' : ''}>{liveSignal ? 'Healthy' : 'No signal'}</strong></div></div><div className="mini-channel-list">{telemetry.channels.slice(0, 8).map((v, i) => <ChannelBar key={i} index={i} value={v} min={rangeMin} max={rangeMax} compact/> )}</div><div className="panel-footnote"><span className="footnote-dot"/> {telemetry.channelUpdatedAt ? `Updated ${fmtTime(telemetry.channelUpdatedAt)}` : 'Channel data appears here when the ESP32 emits CH lines.'}</div></div>
          <div className="panel quick-panel"><PanelTitle icon={Zap} title="Quick actions" subtitle="Common configuration tasks"/><div className="quick-actions"><QuickAction icon={SlidersHorizontal} title="Calibrate ranges" desc="Adjust min, centre and max pulse values" onClick={() => setPage('Ranges')}/><QuickAction icon={Terminal} title="Open CLI console" desc="Send commands and inspect firmware output" onClick={() => setPage('CLI Console')}/><QuickAction icon={ListChecks} title="Run a command macro" desc="Chain repeatable checks into one action" onClick={() => setPage('Automation Lab')}/><QuickAction icon={Download} title="Export configuration" desc="Download ranges and profile data as JSON" onClick={exportProfile}/></div></div></section>
          <section className="bottom-grid"><div className="panel activity-panel"><PanelTitle icon={History} title="Session activity" subtitle="Latest serial output" action={<button className="text-action" onClick={() => setPage('CLI Console')}>View console <ArrowUpRight size={14}/></button>}/><div className="activity-list">{consoleText.slice(-4).reverse().map((line, i) => <div className="activity-row" key={`${line}-${i}`}><span className={`activity-icon ${line.startsWith('!') ? 'warn' : line.startsWith('✓') ? 'success' : ''}`}>{line.startsWith('!') ? <CircleHelp size={14}/> : line.startsWith('✓') ? <Check size={14}/> : <Terminal size={14}/>}</span><span className="activity-text">{line}</span><span className="activity-time">{i === 0 ? 'LATEST' : `${i + 1} ago`}</span></div>)}</div></div><div className="panel protocol-panel"><PanelTitle icon={Cpu} title="Protocol status" subtitle="Data source and readiness" action={<button className="text-action" disabled={!connected && !demoMode} onClick={() => { setPage('CLI Console'); void sendRaw('version'); }}>Probe firmware <ArrowUpRight size={14}/></button>}/><div className="protocol-list"><StatusRow label="Desktop bridge" value={desktop ? 'AVAILABLE' : 'BROWSER PREVIEW'} good={desktop}/><StatusRow label="Serial link" value={connected ? 'CONNECTED' : demoMode ? 'DEMO' : 'DISCONNECTED'} good={connected || demoMode}/><StatusRow label="Channel stream" value={telemetry.channelUpdatedAt ? 'SEEN' : 'WAITING'} good={!!telemetry.channelUpdatedAt}/><StatusRow label="Firmware identification" value={firmware.label} good={firmware.kind === 'esp-fc'}/></div><div className="protocol-note"><ShieldCheck size={15}/> {firmware.detail} Writes are explicit. RangeLab won't silently flash firmware.</div></div></section>
        </>}

        {page === 'Receiver' && <><PageHeading eyebrow="LIVE TELEMETRY" title="Receiver monitor" desc="Inspect all 16 RC channels, pulse widths and movement in real time." badge={liveSignal ? 'SIGNAL LIVE' : 'AWAITING DATA'} /><div className="panel receiver-full"><div className="receiver-full-head"><div><h3>Channel input map</h3><p>Pulse width in microseconds · 1000–2000 µs is a common range, not a universal rule.</p></div><div className="legend"><span><i className="legend-dot low"/>Low</span><span><i className="legend-dot center"/>Centre</span><span><i className="legend-dot high"/>High</span></div></div><div className="channels-grid">{telemetry.channels.map((v, i) => <ChannelCard key={i} index={i} value={v} min={rangeMin} max={rangeMax}/>)}</div><div className="receiver-bottom"><div><span className="muted-label">LAST CHANNEL FRAME</span><strong>{fmtTime(telemetry.channelUpdatedAt)}</strong></div><div><span className="muted-label">FRAME SOURCE</span><strong>ESP32 USB serial bridge</strong></div><button className="secondary-button" onClick={() => setPage('Ranges')}><SlidersHorizontal size={15}/> Tune ranges</button></div></div><div className="info-banner"><CircleHelp size={17}/><span>This view reads ASCII lines such as <code>CH,1500,1500,...</code> from your ESP32 sketch. It does not claim to decode raw CRSF over USB; the ESP32 bridge firmware is responsible for that.</span></div></>}

        {page === 'Ranges' && <><PageHeading eyebrow="INPUT CALIBRATION" title="Ranges & endpoints" desc="Set the pulse window used by the current ESP-FC firmware profile. Validate values before sending them." badge="CONFIGURATION"/><div className="ranges-layout"><div className="panel range-editor"><PanelTitle icon={SlidersHorizontal} title="Pulse range editor" subtitle="Microseconds (µs)"/><div className="preset-row"><label htmlFor="range-preset">Starting profile</label><div className="select-wrap"><select id="range-preset" value={presetName} onChange={e => selectPreset(e.target.value)}>{savedProfiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}</select><ChevronDown size={15}/></div></div><div className="range-visual"><div className="range-scale"><span>800</span><span>1200</span><span>1600</span><span>2000</span><span>2200</span></div><div className="range-track"><div className="range-fill" style={{ left: `${Math.max(0, Math.min(100, (rangeMin - 800) / 1400 * 100))}%`, width: `${Math.max(0, Math.min(100, (rangeMax - rangeMin) / 1400 * 100))}%` }}/><span className="range-marker min" style={{ left: `${Math.max(0, Math.min(100, (rangeMin - 800) / 1400 * 100))}%` }} title="Minimum"/><span className="range-marker mid" style={{ left: `${Math.max(0, Math.min(100, (rangeMid - 800) / 1400 * 100))}%` }} title="Centre"/><span className="range-marker max" style={{ left: `${Math.max(0, Math.min(100, (rangeMax - 800) / 1400 * 100))}%` }} title="Maximum"/></div><div className="range-legend"><span><i className="legend-dot low"/>Minimum</span><span><i className="legend-dot center"/>Centre</span><span><i className="legend-dot high"/>Maximum</span></div></div><div className="range-fields"><RangeField label="Minimum input" value={rangeMin} onChange={setRangeMin} min={750} max={1250} help="Lowest expected pulse"/><RangeField label="Centre input" value={rangeMid} onChange={setRangeMid} min={1250} max={1750} help="Neutral stick position"/><RangeField label="Maximum input" value={rangeMax} onChange={setRangeMax} min={1750} max={2250} help="Highest expected pulse"/></div>{!isValidRange(rangeMin, rangeMid, rangeMax) && <div className="validation-error"><CircleHelp size={15}/> Invalid range. Use whole-number values within each field's limits, with minimum below centre and centre below maximum.</div>}<div className="range-actions"><button className="secondary-button" onClick={saveProfile}><Save size={15}/> Save profile</button><button className="secondary-button" onClick={exportProfile}><Download size={15}/> Export JSON</button><button className="primary-button" disabled={(!connected && !demoMode) || !isValidRange(rangeMin, rangeMid, rangeMax)} onClick={() => void applyRanges()}><Send size={15}/> {demoMode ? 'Simulate changes' : 'Send to ESP-FC'}</button></div><div className="caution-note"><ShieldCheck size={16}/><div><strong>{demoMode ? 'Simulation only' : 'Review before saving to firmware'}</strong><span>{demoMode ? 'Demo mode never writes to hardware. Endpoint commands and replies are simulated locally so you can explore the workflow safely.' : <>RangeLab sends three <code>set input_*</code> commands. Inspect the CLI response first; the firmware may reject a parameter or require a separate <code>save</code> command. It will not automatically reboot your controller.</>}</span></div></div></div><div className="range-side"><div className="panel range-reference"><PanelTitle icon={BookOpen} title="Profile reference" subtitle="Current selection"/><div className="reference-number-row"><div><span>MINIMUM</span><strong>{rangeMin}<small> µs</small></strong></div><div><span>CENTRE</span><strong>{rangeMid}<small> µs</small></strong></div><div><span>MAXIMUM</span><strong>{rangeMax}<small> µs</small></strong></div></div><div className="reference-desc">{savedProfiles.find(p => p.name === presetName)?.notes ?? 'Custom configuration profile.'}</div><div className="reference-divider"/><div className="reference-fact"><span>Range width</span><strong>{rangeMax - rangeMin} µs</strong></div><div className="reference-fact"><span>Lower headroom from centre</span><strong>{rangeMid - rangeMin} µs</strong></div><div className="reference-fact"><span>Upper headroom from centre</span><strong>{rangeMax - rangeMid} µs</strong></div></div><div className="panel saved-profile-panel"><PanelTitle icon={BookOpen} title="Saved profiles" subtitle={`${savedProfiles.length} available`}/>{savedProfiles.map(p => <button className={`saved-profile ${p.name === presetName ? 'selected' : ''}`} key={p.name} onClick={() => selectPreset(p.name)}><span className="saved-profile-icon"><SlidersHorizontal size={15}/></span><span className="saved-profile-text"><strong>{p.name}</strong><small>{p.min} / {p.mid} / {p.max} µs</small></span>{p.name === presetName && <Check size={15}/>}</button>)}</div></div></div></>}

        {page === 'CLI Console' && <><PageHeading eyebrow="DIRECT FIRMWARE ACCESS" title="CLI console" desc="A raw serial console with session history. Commands are sent exactly as typed." badge={connected ? 'PORT OPEN' : demoMode ? 'SIMULATION' : 'PORT CLOSED'} actions={<button className="secondary-button" onClick={downloadLog}><ArrowDownToLine size={15}/> Export log</button>}/><div className="panel cli-panel"><div className="cli-toolbar"><div className="cli-title"><Terminal size={17}/><span>Serial terminal</span><span className={`terminal-status ${connected ? 'active' : ''}`}>{connected ? 'CONNECTED' : demoMode ? 'DEMO SIMULATION' : 'DISCONNECTED'}</span></div><div className="cli-toolbar-actions"><button className="tiny-action" onClick={clearConsole}><X size={14}/> Clear</button><button className="tiny-action" onClick={downloadLog}><Download size={14}/> Save log</button></div></div><div className="cli-output" role="log" aria-live="polite">{consoleText.map((line, i) => <div className={`cli-line ${line.startsWith('→') ? 'sent' : line.startsWith('!') ? 'error' : line.startsWith('✓') ? 'success' : ''}`} key={`${i}-${line}`}><span className="cli-line-no">{String(i + 1).padStart(3, '0')}</span><span>{line}</span></div>)}<div ref={consoleEnd}/></div><form className="cli-input-row" onSubmit={sendCommand}><span className="prompt">&gt;_</span><input value={command} onChange={e => { setCommand(e.target.value); if (historyIndex >= 0) setHistoryIndex(-1); }} onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { if (navigateCommandHistory(e.key)) e.preventDefault(); } }} placeholder={connected ? 'Enter a firmware command…' : demoMode ? 'Try help, status, version, or get input_min' : 'Connect a device or start demo mode'} disabled={!connected && !demoMode}/><kbd>ENTER ↵</kbd><button className="send-icon-button" type="submit" disabled={(!connected && !demoMode) || !command.trim()} aria-label="Send command"><Send size={17}/></button></form><div className="cli-footer"><span><span className={`tiny-dot ${connected ? 'green-dot' : ''}`}/>{connected ? `${portName} · ${baud.toLocaleString()} baud` : demoMode ? 'Local simulator · no hardware writes' : 'No serial transport'}</span><span>{consoleText.length} log entries</span></div></div><div className="command-chips"><span>QUICK COMMANDS</span>{['help', 'version', 'status', 'get input_min', 'get input_mid', 'get input_max'].map(cmd => <button key={cmd} onClick={() => { setCommand(cmd); }} disabled={!connected && !demoMode}><code>{cmd}</code><ArrowUpRight size={12}/></button>)}</div></>}

        {page === 'Automation Lab' && <><PageHeading eyebrow="REPEATABLE WORKFLOWS" title="Automation lab" desc="Build small command sequences for inspection, calibration and repeatable setup tasks." badge="LOCAL MACROS"/><div className="automation-layout"><div className="panel macro-editor"><PanelTitle icon={Code2} title="Command sequence" subtitle="Commands run in order, one line at a time."/><label className="field-label" htmlFor="macro-name">Macro name</label><input id="macro-name" className="text-field" value={macroName} disabled={macroRunning} onChange={e => setMacroName(e.target.value)}/><label className="field-label" htmlFor="macro-body">Commands</label><textarea id="macro-body" className="code-field" value={macroBody} disabled={macroRunning} onChange={e => setMacroBody(e.target.value)} spellCheck={false}/><div className="macro-meta"><span><Code2 size={14}/>{macroBody.split('\n').filter(x => x.trim()).length} commands</span><span><ShieldCheck size={14}/> Local execution only</span></div><div className="macro-actions"><button className="secondary-button" disabled={macroRunning} onClick={() => { setMacroName('Read firmware info'); setMacroBody('version\nstatus\nget input_min\nget input_mid\nget input_max'); }}>Reset example</button>{macroRunning ? <button className="disconnect-button" onClick={() => { macroCancelRequested.current = true; notify('Stopping macro after the current command…'); }}><Square size={14}/> Stop sequence</button> : <button className="primary-button" onClick={() => void runMacro()} disabled={!connected && !demoMode}><Zap size={15}/> Run sequence</button>}</div></div><div className="panel macro-help"><PanelTitle icon={BookOpen} title="Macro patterns" subtitle="Examples you can adapt"/><button className="macro-example" onClick={() => { setMacroName('Inspect receiver'); setMacroBody('status\nstats\nget input_min\nget input_mid\nget input_max'); }}><span className="macro-example-icon"><Activity size={16}/></span><span><strong>Inspect receiver</strong><small>Status, counters and current endpoints</small></span><ArrowUpRight size={14}/></button><button className="macro-example" onClick={() => { setMacroName('Read configuration'); setMacroBody('version\nget features\nget serial_2\nget input_'); }}><span className="macro-example-icon"><Cpu size={16}/></span><span><strong>Read configuration</strong><small>Firmware version and receiver-related values</small></span><ArrowUpRight size={14}/></button><button className="macro-example" onClick={() => { setMacroName('Basic health check'); setMacroBody('version\nstatus\nstats'); }}><span className="macro-example-icon"><ShieldCheck size={16}/></span><span><strong>Basic health check</strong><small>Quick diagnostic snapshot</small></span><ArrowUpRight size={14}/></button><div className="macro-warning"><CircleHelp size={16}/><span>Macros are sent as plain serial commands. Keep them read-only until you have verified the exact command syntax supported by your firmware.</span></div></div></div></>}

        {page === 'Profiles' && <><PageHeading eyebrow="CONFIGURATION LIBRARY" title="Profiles" desc="Keep named range presets and export portable JSON backups." badge={`${savedProfiles.length} PROFILES`} actions={<><input ref={profileFileInput} type="file" accept=".json,application/json" hidden onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void importProfiles(file); e.currentTarget.value = ''; }}/><button className="secondary-button" onClick={() => profileFileInput.current?.click()}><Upload size={15}/> Import JSON</button><button className="primary-button" onClick={exportProfile}><Download size={15}/> Export all profiles</button></>}/><div className="profile-grid">{savedProfiles.map((p, i) => <div className="panel profile-card" key={p.name}><div className="profile-card-top"><div className="profile-icon"><SlidersHorizontal size={19}/></div><span className="profile-index">PROFILE {String(i + 1).padStart(2, '0')}</span><button className="icon-button" onClick={() => { setPresetName(p.name); setRangeMin(p.min); setRangeMid(p.mid); setRangeMax(p.max); setPage('Ranges'); }} title="Edit profile"><MoreHorizontal size={18}/></button></div><h3>{p.name}</h3><p>{p.notes}</p><div className="profile-values"><div><span>MIN</span><strong>{p.min}</strong></div><div><span>CENTRE</span><strong>{p.mid}</strong></div><div><span>MAX</span><strong>{p.max}</strong></div></div><button className="secondary-button full-button" onClick={() => { selectPreset(p.name); setPage('Ranges'); }}><SlidersHorizontal size={14}/> Load profile</button></div>)}<button className="new-profile-card" onClick={() => { setPresetName(`Custom profile ${savedProfiles.length + 1}`); setPage('Ranges'); }}><div className="new-profile-plus">+</div><strong>Create a custom profile</strong><span>Start from the current range values</span></button></div><div className="info-banner"><Download size={16}/><span>Profiles are saved locally on this computer. Use <strong>Export JSON</strong> to back them up or move them to another machine.</span></div></>}

        {page === 'Diagnostics' && <><PageHeading eyebrow="DEVICE HEALTH" title="Diagnostics" desc="Inspect transport state, received data and the current session log." badge="DIAGNOSTICS" actions={<button className="secondary-button" onClick={downloadLog}><Download size={15}/> Export log</button>}/><div className="diagnostic-grid"><div className="panel diagnostic-card"><PanelTitle icon={Usb} title="Serial transport" subtitle="Host to ESP32"/><StatusRow label="Desktop runtime" value={desktop ? 'NATIVE' : 'WEB PREVIEW'} good={desktop}/><StatusRow label="Port state" value={connected ? 'OPEN' : demoMode ? 'SIMULATED' : 'CLOSED'} good={connected || demoMode}/><StatusRow label="Selected port" value={portName || 'None'} good={!!portName}/><StatusRow label="Baud rate" value={baud.toLocaleString()} good={true}/><div className="diagnostic-buttons"><select value={baud} onChange={e => setBaud(Number(e.target.value))} disabled={connected || demoMode}><option value={115200}>115200 baud</option><option value={420000}>420000 baud</option><option value={230400}>230400 baud</option><option value={57600}>57600 baud</option><option value={9600}>9600 baud</option></select><button className="secondary-button" onClick={() => void refreshPorts()}><RefreshCw size={14}/> Refresh</button></div></div><div className="panel diagnostic-card"><PanelTitle icon={Activity} title="Telemetry stream" subtitle="ASCII bridge parser"/><StatusRow label="Channel frames" value={telemetry.channelUpdatedAt ? 'RECEIVED' : 'NONE'} good={!!telemetry.channelUpdatedAt}/><StatusRow label="Link-stat frames" value={telemetry.link ? 'RECEIVED' : 'NONE'} good={!!telemetry.link}/><StatusRow label="Last data" value={fmtTime(telemetry.lastLineAt)} good={!!telemetry.lastLineAt}/><StatusRow label="Retained log lines" value={telemetry.rawLines.length.toString()} good={true}/><div className="diagnostic-buttons"><button className="secondary-button" onClick={() => { setPage('CLI Console'); }}><Terminal size={14}/> Inspect console</button><button className="secondary-button" onClick={() => { setTelemetry(EMPTY_TELEMETRY); notify('Telemetry view reset'); }}><RefreshCw size={14}/> Reset view</button></div></div></div><div className="panel raw-data-panel"><PanelTitle icon={History} title="Recent raw data" subtitle="Last 40 serial lines" action={<button className="text-action" onClick={downloadLog}>Export session <ArrowDownToLine size={14}/></button>}/><div className="raw-lines">{telemetry.rawLines.slice(-40).reverse().map((line, i) => <div key={`${i}-${line}`}><span>{String(telemetry.rawLines.length - i).padStart(3, '0')}</span><code>{line}</code></div>)}{telemetry.rawLines.length === 0 && <div className="empty-raw">No serial lines received yet. Connect to the ESP32 to begin capturing data.</div>}</div></div></>}
      </div>
      <footer className="app-footer"><div><span className="footer-mark"><AudioWaveform size={14}/></span><span>RangeLab</span><span className="footer-sep">·</span><span>Built for curious builders.</span></div><div><span className="footer-state"><span className={`tiny-dot ${connected ? 'green-dot' : ''}`}/>{connected ? 'Serial bridge active' : demoMode ? 'Demo simulator active' : 'Offline mode'}</span><span className="footer-sep">·</span><a href="https://github.com/Thomas-Paulson/betaflight-esp" target="_blank" rel="noreferrer"><Github size={13}/> Source project</a></div></footer>
    </main>
    {toast && <div className="toast"><Check size={16}/>{toast}</div>}
  </div>;
}

function Metric({ icon: Icon, label, value, sub, tone }: { icon: typeof Activity; label: string; value: string; sub: string; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={18}/></div><div className="metric-copy"><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-sub">{sub}</span></div><div className={`metric-accent ${tone}`}/></div>;
}
function PanelTitle({ icon: Icon, title, subtitle, action }: { icon: typeof Activity; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="panel-title"><div className="panel-title-icon"><Icon size={16}/></div><div className="panel-title-copy"><h2>{title}</h2><p>{subtitle}</p></div>{action && <div className="panel-title-action">{action}</div>}</div>;
}
function ChannelBar({ index, value, min, max, compact = false }: { index: number; value: number; min: number; max: number; compact?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value - 800) / 1400 * 100));
  return <div className={`channel-bar ${compact ? 'compact' : ''}`}><span className="channel-name">CH{String(index + 1).padStart(2, '0')}</span><div className="channel-track"><span className="channel-track-center"/><span className={`channel-indicator ${value < min ? 'below' : value > max ? 'above' : ''}`} style={{ left: `${pct}%` }}/></div><strong>{value}</strong></div>;
}
function ChannelCard({ index, value, min, max }: { index: number; value: number; min: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value - 800) / 1400 * 100));
  const status = pulseLabel(value);
  return <div className="channel-card"><div className="channel-card-top"><span className="channel-card-name">CH {String(index + 1).padStart(2, '0')}</span><span className={`channel-status ${value < min || value > max ? 'out-of-range' : status === 'CENTRE' ? 'centred' : ''}`}>{value < min || value > max ? 'OUT OF RANGE' : status}</span></div><div className="channel-value">{value}<small>µs</small></div><div className="channel-card-track"><span className="channel-track-center"/><span className={`channel-indicator ${value < min ? 'below' : value > max ? 'above' : ''}`} style={{ left: `${pct}%` }}/></div><div className="channel-card-foot"><span>{min} min</span><span>1500 centre</span><span>{max} max</span></div></div>;
}
function QuickAction({ icon: Icon, title, desc, onClick }: { icon: typeof Activity; title: string; desc: string; onClick: () => void }) {
  return <button className="quick-action" onClick={onClick}><span className="quick-action-icon"><Icon size={17}/></span><span className="quick-action-copy"><strong>{title}</strong><small>{desc}</small></span><ArrowUpRight size={15} className="quick-arrow"/></button>;
}
function StatusRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div className="status-row"><span>{label}</span><strong className="status-row-value"><i className={good ? 'status-indicator good' : 'status-indicator'}/>{value}</strong></div>;
}
function PageHeading({ eyebrow, title, desc, badge, actions }: { eyebrow: string; title: string; desc: string; badge: string; actions?: ReactNode }) {
  return <section className="page-heading compact-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p>{desc}</p></div><div className="page-heading-right">{actions}<span className="build-tag"><span className="tiny-dot"/>{badge}</span></div></section>;
}
function RangeField({ label, value, onChange, min, max, help }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; help: string }) {
  return <div className="range-field"><label>{label}<span>{help}</span></label><div className="range-input-wrap"><input type="number" value={value} min={min} max={max} onChange={e => onChange(Number(e.target.value))}/><span>µs</span></div><input className="range-slider" type="range" min={min} max={max} value={Math.max(min, Math.min(max, value))} onChange={e => onChange(Number(e.target.value))} aria-label={label}/></div>;
}
