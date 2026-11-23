// ============================================================================
// mapa.mjs — Mapa da ilha visto de cima, gerado no Node direto de world.js
// (sem navegador): relevo, mar, praia, rios, mata e, opcionalmente, árvores.
// Também sonda pontos e resume o mundo em números
// Uso: node .devin/skills/bbc-terreno/scripts/mapa.mjs [--out=/tmp/bbc-mapa.png]
//      [--res=520] [--seed=2026] [--arvores] [--sonda=x,z] [--sonda=...]
// ============================================================================

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, parseArgs, encodePng } from '../../bbc-verificar/scripts/lib.mjs';

const args = parseArgs();
const probes = process.argv.slice(2).filter((a) => a.startsWith('--sonda=')).map((a) => a.slice(8).split(',').map(Number));
const res = parseInt(args.res || 520, 10);
const out = args.out || '/tmp/bbc-mapa.png';

globalThis.window ??= { devicePixelRatio: 1 };
const load = (f) => import(pathToFileURL(join(ROOT, 'src', f)).href);
const { ForestWorld } = await load('world.js');
const { QUALITY_PRESETS } = await load('quality.js');
const world = new ForestWorld(parseInt(args.seed || 2026, 10));
const S = world.worldSize, WL = world.waterLevel;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.min(1, Math.max(0, t)));
const rgb = new Uint8Array(res * res * 3);
let land = 0, maxH = -1e9, maxAt = [0, 0], minH = 1e9, river = 0, bad = 0;
const hAt = new Float32Array(res * res);
for (let j = 0; j < res; j++) {
  for (let i = 0; i < res; i++) {
    const x = (i + 0.5) / res * S - S / 2, z = (j + 0.5) / res * S - S / 2;
    const h = world.getTerrainHeight(x, z);
    hAt[j * res + i] = h;
    if (!Number.isFinite(h)) { bad++; continue; }
    const shore = world.shoreDist(x, z), mask = world.mountMask(x, z);
    if (h > maxH) { maxH = h; maxAt = [x, z]; }
    if (h < minH) minH = h;
    let c;
    if (h < WL) {
      c = mix([96, 190, 200], [18, 52, 110], (WL - h) / 5.0);
      if (shore > 0) { c = mix([70, 150, 230], [30, 90, 200], (WL - h) / 3.0); river++; }
    } else {
      land++;
      const sand = 1.0 - Math.min(1, Math.max(0, (shore - S * 0.01) / (S * 0.03)));
      c = mix([150, 170, 95], [30, 95, 45], world.forestDensity(x, z)); // campo → mata
      c = mix(c, [232, 214, 160], sand);
      c = mix(c, [120, 112, 100], mask * Math.min(1, Math.max(0, (h - 14) / 20))); // rocha acima da linha das árvores
      c = mix(c, [245, 248, 252], (h - 85) / 25); // neve
    }
    rgb.set(c.map(Math.round), (j * res + i) * 3);
  }
}
// Sombreamento do relevo (luz de noroeste) e curvas de nível a cada 20 m
for (let j = 1; j < res - 1; j++) {
  for (let i = 1; i < res - 1; i++) {
    const k = j * res + i, h = hAt[k];
    if (h < WL) continue;
    const step = S / res;
    const shade = 1.0 + Math.max(-0.45, Math.min(0.45, ((hAt[k + 1] - hAt[k - 1]) + (hAt[k + res] - hAt[k - res])) / step * 0.35));
    const contour = h > 10 && Math.floor(h / 20) !== Math.floor(hAt[k + 1] / 20) ? 0.72 : 1.0;
    for (let c = 0; c < 3; c++) rgb[k * 3 + c] = Math.min(255, rgb[k * 3 + c] * shade * contour);
  }
}
const toPx = (v) => Math.floor((v + S / 2) / S * res);
const dot = (x, z, color, r = 3) => {
  const cx = toPx(x), cz = toPx(z);
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const px = cx + i, pz = cz + j;
    if (px >= 0 && pz >= 0 && px < res && pz < res && Math.hypot(i, j) <= r + 0.3) rgb.set(color, (pz * res + px) * 3);
  }
};

let instInfo = '';
if (args.arvores) {
  const key = typeof args.arvores === 'string' ? args.arvores : 'medium';
  const preset = QUALITY_PRESETS[key];
  const t0 = Date.now();
  const inst = world.generateInstances(preset);
  for (const name of ['trunksA', 'trunksB']) for (let i = 0; i < inst[name].length; i += 8) dot(inst[name][i], inst[name][i + 2], name === 'trunksA' ? [12, 60, 24] : [10, 40, 60], 0);
  const counts = Object.keys(inst.grid.starts).map((k) => `${k} ${inst[k].length / 8}`).join(' · ');
  const got = inst.trunkACount + inst.trunkBCount;
  instInfo = `instâncias (${key}, ${((Date.now() - t0) / 1000).toFixed(1)}s): ${counts}\n` +
    `árvores colocadas: ${got} de ${preset.trees} pedidas${got < preset.trees * 0.95 ? '  ← ABAIXO do pedido: as regras de rejeição em generateInstances() estão barrando demais' : ''}`;
}
dot(world.spawn.cam[0], world.spawn.cam[1], [255, 40, 40]);
for (const p of probes) dot(p[0], p[1], [255, 0, 255]);
writeFileSync(out, encodePng(res, res, rgb));

const cell = (S / res) ** 2;
console.log(`${out} (${res}×${res}, ${(S / res).toFixed(1)} m/pixel; norte em cima, +x = leste/direita, +z = sul/baixo)`);
console.log('legenda: azul-escuro mar fundo · ciano raso · azul vivo rio · areia bege · verde-claro campo · verde-escuro mata · cinza rocha · branco neve · ponto vermelho câmera inicial · magenta sondas');
console.log(`seed ${world.seed} · mundo ${S} m · terra emersa ${(land * cell / 1e6).toFixed(2)} km² (${(100 * land / (res * res)).toFixed(1)}% do mapa) · rios ${(river * cell / 1e4).toFixed(1)} ha`);
console.log(`altura: mín ${minH.toFixed(1)} m · máx ${maxH.toFixed(1)} m em (${maxAt[0].toFixed(0)}, ${maxAt[1].toFixed(0)}) · nível d'água ${WL}`);
console.log(`câmera inicial: (${world.spawn.cam[0].toFixed(1)}, ${world.spawn.cam[1].toFixed(1)}) yaw ${world.spawn.yaw.toFixed(2)}`);
if (bad) console.log(`ERRO: ${bad} pontos com altura NaN/Infinity`);
if (instInfo) console.log(instInfo);
for (const [x, z] of probes) {
  const h = world.getTerrainHeight(x, z), n = world.getTerrainNormal(x, z);
  console.log(`sonda (${x}, ${z}): altura ${h.toFixed(2)} m${h < WL ? ` (submerso ${(WL - h).toFixed(2)} m)` : ''} · shoreDist ${world.shoreDist(x, z).toFixed(1)} · mountMask ${world.mountMask(x, z).toFixed(2)} · riverDist ${world.riverDist(x, z).toFixed(1)} · riverMask ${world.riverMask(x, z).toFixed(2)} · forestDensity ${world.forestDensity(x, z).toFixed(2)} · inclinação ${(Math.acos(n[1]) * 180 / Math.PI).toFixed(0)}°`);
}
process.exit(bad ? 1 : 0);
