// bake-maos.mjs — converte o modelo CC0 'WRAD ARMS' (wriks, itch.io) em
// src/hands.js: posições/normais/uvs no espaço glTF original + cor por
// vértice assada da textura albedo. Regenerar:
//   node tools/bake-maos.mjs
// O posicionamento no viewmodel (rotação/escala/offset) fica em world.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng } from '../.devin/skills/bbc-verificar/scripts/lib.mjs';

const GLB = 'assets/wrad/arms.glb';
const ALBEDO = 'assets/wrad/arm_albedo_pale.png';
const OUT = 'src/hands.js';

// --- GLB mínimo: primeiro primitive (POSITION/NORMAL/TEXCOORD_0/indices) ---
const buf = readFileSync(GLB);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const binOff = 20 + jsonLen + 8; // header do chunk BIN

function accessor(i) {
  const a = gltf.accessors[i], v = gltf.bufferViews[a.bufferView];
  const off = binOff + (v.byteOffset || 0) + (a.byteOffset || 0);
  const comp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  return new T(buf.buffer, buf.byteOffset + off, a.count * comp);
}

const prim = gltf.meshes[0].primitives[0];
const pos = accessor(prim.attributes.POSITION);
const nrm = accessor(prim.attributes.NORMAL);
const uv = accessor(prim.attributes.TEXCOORD_0);
const idx = prim.indices !== undefined ? accessor(prim.indices) : null;
const indices = idx || Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);

// --- Assa albedo → cor por vértice (amostragem bilinear, v invertida) ---
const tex = decodePng(readFileSync(ALBEDO));
const sample = (u, v) => {
  const x = Math.min(tex.width - 1, Math.max(0, u * (tex.width - 1)));
  const y = Math.min(tex.height - 1, Math.max(0, (1 - v) * (tex.height - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(tex.width - 1, x0 + 1), y1 = Math.min(tex.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, c = [0, 0, 0];
  for (const [px, py, w] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
    const p = (py * tex.width + px) * tex.channels;
    c[0] += (tex.px[p] / 255) * w; c[1] += (tex.px[p + 1] / 255) * w; c[2] += (tex.px[p + 2] / 255) * w;
  }
  return c;
};

const n = pos.length / 3;
const colors = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  const c = sample(uv[i * 2], uv[i * 2 + 1]);
  colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
}

const r4 = (a) => Array.from(a, (v) => +v.toFixed(4));
const src = `// ============================================================
// Big Buck Country — Modelo das mãos em primeira pessoa (modo jogo)
// ============================================================
// GERADO por tools/bake-maos.mjs — não editar à mão.
// Fonte: 'WRAD ARMS' por wriks — CC0 1.0 Universal
// https://wriks.itch.io/wrad-arms  (licença: assets/wrad/LICENSE.txt)
// Dados no espaço glTF cru (-z frente, +y cima); a conversão p/ o
// viewmodel (+z frente) e o posicionamento são feitos em world.js.

export const HANDS_MODEL = {
  positions: new Float32Array(${JSON.stringify(r4(pos))}),
  normals:   new Float32Array(${JSON.stringify(r4(nrm))}),
  colors:    new Float32Array(${JSON.stringify(r4(colors))}),
  uvs:       new Float32Array(${JSON.stringify(r4(uv))}),
  indices:   new Uint32Array(${JSON.stringify(Array.from(indices))})
};
`;

writeFileSync(OUT, src);
console.log(`${OUT}: ${n} vértices, ${indices.length / 3} triângulos, ${src.length} bytes`);
