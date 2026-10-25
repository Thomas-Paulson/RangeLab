import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The phone page is three files served from ESP32 flash plus one sketch that
// serves them. Nothing at runtime checks that they agree, so a renamed id or a
// moved route breaks the page silently on a device with no console. These checks
// are static: they compare the files the firmware actually embeds.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const app = read('mobile/app.js');
const page = read('mobile/index.html');
const sketch = read('firmware/RangeLab_ESP32.ino');
const assets = read('firmware/web_assets.h');

const idsIn = (html: string) => new Set(Array.from(html.matchAll(/id="([^"]+)"/g), (m) => m[1]));
const elCallsIn = (js: string) =>
  new Set(Array.from(js.matchAll(/\bel\('([^']+)'\)/g), (m) => m[1]));

test('mobile page: every element the script looks up exists in the HTML', () => {
  const ids = idsIn(page);
  const wanted = elCallsIn(app);
  assert.ok(wanted.size > 10, 'expects the script to look up the page elements');
  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `missing ids in mobile/index.html: ${missing.join(', ')}`);
});

test('mobile page: the fields the RX and power views write to are present', () => {
  const ids = idsIn(page);
  for (const id of ['device', 'link', 'receiver', 'outputs', 'rail', 'rail-label', 'wire', 'events', 'event-count', 'trace']) {
    assert.ok(ids.has(id), `#${id} is written by the script and must exist`);
  }
});

test('mobile page: the firmware serves every file the page asks for', () => {
  // <script type="module" src="..."> plus the module's own relative imports.
  const scripts = Array.from(page.matchAll(/<script[^>]*src="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(scripts, ['/app.js']);

  const imports = Array.from(app.matchAll(/from '\.\/([^']+)'/g), (m) => m[1]);
  assert.deepEqual(imports, ['bridge.js']);

  const routed = Array.from(sketch.matchAll(/path=="(\/[^"]*)"/g), (m) => m[1]);
  for (const path of [...scripts, ...imports.map((file) => `/${file}`)]) {
    assert.ok(routed.includes(path), `${path} is requested by the page but not served by the sketch`);
  }
});

test('mobile page: the embedded assets match the files on disk', () => {
  // The sketch serves firmware/web_assets.h, not mobile/. A stale embed ships an
  // old page, which is the one failure mode a passing field test can hide.
  for (const [symbol, source] of [['INDEX_HTML', page], ['BRIDGE_JS', read('mobile/bridge.js')], ['APP_JS', app]] as const) {
    const start = assets.indexOf(`R"RL_${symbol}(`);
    assert.ok(start > 0, `${symbol} is missing from firmware/web_assets.h`);
    const body = assets.slice(start + `R"RL_${symbol}(`.length);
    const end = body.indexOf(`)RL_${symbol}"`);
    assert.ok(end > 0, `${symbol} is not terminated`);
    assert.equal(body.slice(0, end), source, `${symbol} is stale: run npm run mobile:embed`);
  }
});

test('mobile page: works with no internet, only the ESP32', () => {
  // There is no uplink on the access point, so any external URL is a broken asset.
  const external = page.match(/(?:src|href)="https?:\/\/[^"]*"/g) ?? [];
  assert.deepEqual(external, [], 'the page must not load anything from the internet');
  assert.ok(!/@import|fonts\.googleapis|cdn\./.test(page), 'no external styles or fonts');
  // Styles must be inline: the sketch only routes /, /app.js, /bridge.js and /health.
  assert.ok(page.includes('<style>'), 'the page carries its own styles');
});
