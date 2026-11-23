// ============================================================================
// lib.mjs — Base sem dependências dos scripts dos skills: servidor estático
// na porta 3000, Chrome headless via CDP (WebSocket nativo do Node 22+),
// leitura/escrita de PNG e o roteiro comum de abertura do app
// ============================================================================

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PORT = 3000;
export const URL_APP = `http://localhost:${PORT}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --flag=valor e --flag viram { flag: 'valor' | true }
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8'
};

// Sobe o servidor estático na porta 3000. Se a porta já estiver servindo
// este projeto (python3 -m http.server do usuário), reaproveita e não fecha
export async function startServer() {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, URL_APP).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = resolve(ROOT, '.' + p);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end('404');
    }
  });
  const started = await new Promise((ok, fail) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? ok(false) : fail(e)));
    server.listen(PORT, '127.0.0.1', () => ok(true));
  });
  if (started) return { reused: false, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  const probe = await fetch(`${URL_APP}/src/main.js`).then((r) => r.ok && r.text(), () => false);
  if (!probe || !probe.includes('BigBuckApp')) {
    throw new Error(`Porta ${PORT} ocupada por outro processo que não serve este projeto. Libere-a (lsof -i :${PORT}) e rode de novo.`);
  }
  return { reused: true, close: async () => {} };
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('Chrome não encontrado. Defina CHROME_PATH com o caminho do executável.');
  return found;
}

// Abre o Chrome headless com WebGPU e devolve a página já conectada por CDP
export async function launchChrome({ width = 1280, height = 720 } = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22+ é necessário (WebSocket nativo).');
  const profile = await mkdtemp(join(tmpdir(), 'bbc-chrome-'));
  const proc = spawn(chromePath(), [
    '--headless=new', '--enable-unsafe-webgpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const port = await new Promise((ok, fail) => {
    let err = '';
    const timer = setTimeout(() => fail(new Error('Chrome não abriu a porta de depuração em 20s.\n' + err)), 20000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); fail(new Error(`Chrome saiu com código ${code}.\n${err}`)); });
  });

  let target;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === 'page');
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Chrome abriu sem nenhuma aba.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('Falha ao conectar no CDP.')); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`)); else p.ok(msg.result);
    } else {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    }
  };

  const page = {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((ok, fail) => { pending.set(id, { ok, fail, method }); ws.send(JSON.stringify({ id, method, params })); });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    // Avalia uma expressão na página e devolve o valor (JSON)
    async evaluate(expression) {
      const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('Erro na página: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    // Repete a expressão até dar verdadeiro; devolve false se estourar o prazo
    async waitFor(expression, timeoutMs = 60000, stepMs = 250) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const v = await page.evaluate(expression).catch(() => false);
        if (v) return v;
        await sleep(stepMs);
      }
      return false;
    },
    async screenshot(file, format = file.endsWith('.jpg') ? 'jpeg' : 'png') {
      const r = await page.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 88 } : {}) });
      const buf = Buffer.from(r.data, 'base64');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(file, buf);
      return buf;
    },
    async close() {
      try { ws.close(); } catch {}
      proc.kill('SIGKILL');
      await sleep(200);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return page;
}

// Injetado antes do app: guarda as mensagens de compilação de cada módulo
// WGSL (com o texto da linha culpada) e os erros de validação da GPU
const HOOK = `(() => {
  window.__bbc = { wgsl: [], gpu: [], modules: 0 };
  if (!navigator.gpu) return;
  const csm = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const mod = csm.call(this, desc);
    const index = window.__bbc.modules++;
    const lines = String(desc.code).split('\\n');
    mod.getCompilationInfo().then((info) => {
      for (const m of info.messages) {
        window.__bbc.wgsl.push({ module: index, type: m.type, line: m.lineNum, col: m.linePos, msg: m.message, src: (lines[m.lineNum - 1] || '').trim() });
      }
    });
    return mod;
  };
  const rd = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const dev = await rd.apply(this, args);
    dev.addEventListener('uncapturederror', (e) => { if (window.__bbc.gpu.length < 20) window.__bbc.gpu.push(e.error.message); });
    return dev;
  };
})();`;

// Abre o app no Chrome headless, entra no mundo e espera a cena ficar pronta.
// Devolve a página e tudo o que o navegador reclamou no caminho
export async function openApp({ width = 1280, height = 720, quality = null } = {}) {
  const server = await startServer();
  let page;
  try {
    page = await launchChrome({ width, height });
  } catch (e) {
    await server.close();
    throw e;
  }
  const log = { console: [], exceptions: [], http: [] };
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    log.console.push(`[${p.type}] ` + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    log.exceptions.push(`${d.exception?.description || d.text} (${(d.url || '').replace(URL_APP + '/', '')}:${d.lineNumber + 1})`);
  });
  page.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error' || p.entry.level === 'warning') log.console.push(`[${p.entry.level}] ${p.entry.text}`);
  });
  page.on('Network.responseReceived', (p) => {
    if (p.response.status >= 400 && p.response.url.startsWith(URL_APP)) log.http.push(`${p.response.status} ${p.response.url.replace(URL_APP, '')}`);
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await page.send('Page.navigate', { url: URL_APP });

  const close = async () => { await page.close(); await server.close(); };
  const booted = await page.waitFor(`!!window.bigBuck && document.getElementById('api-pill').textContent.trim() !== ''`, 30000);
  const pill = booted ? await page.evaluate(`document.getElementById('api-pill').textContent.trim()`) : '(app não iniciou)';
  let ready = false;
  if (booted && pill === 'WebGPU HDR') {
    ready = !!(await page.waitFor(`document.getElementById('val-instances').textContent.includes('árvores')`, 180000));
    if (ready) {
      await page.evaluate(`document.getElementById('btn-enter')?.click()`);
      if (quality) {
        await page.evaluate(`document.querySelector('.q-btn[data-quality="${quality}"]').click()`);
      }
      await sleep(1000);
    }
  }
  const gpu = await page.evaluate(`window.__bbc || { wgsl: [], gpu: [] }`).catch(() => ({ wgsl: [], gpu: [] }));
  return { page, server, log, pill, ready, close, readGpu: () => page.evaluate(`window.__bbc`) , gpu };
}

// ----------------------------------------------------------------------------
// PNG mínimo (8 bits, RGB/RGBA, sem entrelaçamento)
// ----------------------------------------------------------------------------
export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePng(buf) {
  let o = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[12] !== 0) throw new Error('PNG fora do formato suportado');
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    o += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst + x - stride] : 0;
      const c = x >= channels && y > 0 ? px[dst + x - stride - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v;
    }
  }
  return { width, height, channels, px };
}

// Resumo numérico de uma captura, para quem não enxerga a imagem: brilho
// médio e contraste da tela inteira e cor média de uma grade 3×3
export function imageStats(png) {
  const { width, height, channels, px } = decodePng(png);
  const cells = Array.from({ length: 9 }, () => [0, 0, 0, 0]);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels, r = px[i], g = px[i + 1], b = px[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l; sum2 += l * l; n++;
      const c = cells[Math.min(2, Math.floor((y / height) * 3)) * 3 + Math.min(2, Math.floor((x / width) * 3))];
      c[0] += r; c[1] += g; c[2] += b; c[3]++;
    }
  }
  const mean = sum / n;
  return {
    width, height, brilho: +mean.toFixed(1), contraste: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1),
    grade: cells.map((c) => '#' + [0, 1, 2].map((k) => Math.round(c[k] / c[3]).toString(16).padStart(2, '0')).join(''))
  };
}
