export type FirmwareKind = 'esp-fc' | 'betaflight' | 'crsf-bridge' | 'unknown';

export type FirmwareIdentity = {
  kind: FirmwareKind;
  label: string;
  detail: string;
  rangeCliSupported: boolean | 'unknown';
};

const identities: Record<FirmwareKind, FirmwareIdentity> = {
  'esp-fc': {
    kind: 'esp-fc',
    label: 'ESP-FC detected',
    detail: 'ESP-FC-style CLI detected. Parameter support still depends on the installed firmware build.',
    rangeCliSupported: true,
  },
  betaflight: {
    kind: 'betaflight',
    label: 'Betaflight detected',
    detail: 'Betaflight normally uses MSP for configurator features. ESP-FC input_min/input_mid/input_max commands will not be assumed compatible.',
    rangeCliSupported: false,
  },
  'crsf-bridge': {
    kind: 'crsf-bridge',
    label: 'Telemetry bridge detected',
    detail: 'The stream looks like an ASCII CRSF/receiver bridge. This does not prove that a firmware configuration CLI is available.',
    rangeCliSupported: false,
  },
  unknown: {
    kind: 'unknown',
    label: 'Firmware not identified',
    detail: 'Run the read-only version command and inspect the response before sending firmware-specific settings.',
    rangeCliSupported: 'unknown',
  },
};

/** Infer a likely firmware family from received serial output, never from a port name. */
export function identifyFirmware(lines: readonly string[]): FirmwareIdentity {
  const received = lines
    .filter(line => line.startsWith('←'))
    .map(line => line.replace(/^←\s*/, ''))
    .join('\n');
  if (!received) return identities.unknown;

  if (/\b(?:ESPF\s+ESP32|ESP-FC|ESPFC)\b/i.test(received)) return identities['esp-fc'];
  if (/\bBetaflight\s+\d|\bBTFL\b|\bBetaflight\b/i.test(received)) return identities.betaflight;
  if (/^CH,\s*\d/m.test(received) || /^LINK,\s*[-+]?\d/m.test(received) || /receiver online/i.test(received)) {
    return identities['crsf-bridge'];
  }
  return identities.unknown;
}
