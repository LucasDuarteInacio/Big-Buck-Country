// ============================================================================
// island.js — Planta da Ilha (traçada do mapa de referência): contorno da
// costa, espinha do maciço central e rede de rios. Fonte única de verdade
// para o relevo/instâncias (world.js) e para o WGSL da água (shaders.js)
// ============================================================================

export const WORLD_SIZE = 2600.0; // ilha ~2.2km × 1.65km + margem de fundo marinho

// Tudo em frações de WORLD_SIZE, origem no centro da ilha, +x = leste e
// +z = sul (o mapa visto de cima, norte para cima)
export const ISLAND = {
  // Costa em coordenadas polares: R(θ) = r0 + Σ aₖ·cos(kθ) + bₖ·sin(kθ)
  coastR0: 0.34967,
  coastHarm: [
    [-0.01571, 0.02226], [0.05493, 0.01643], [-0.00355, 0.00567], [0.00966, 0.02428],
    [0.01614, 0.00073], [0.00149, -0.00283], [0.00164, 0.00015], [-0.00112, 0.00074],
    [0.00527, -0.00091], [0.00499, -0.00439], [0.00006, -0.00251], [0.00142, -0.00111]
  ],
  // Maciço central: cadeia de cápsulas [x, z, raio] de sudoeste a nordeste
  mountSpine: [
    [-0.0388, 0.0569, 0.0607], [-0.0089, 0.0342, 0.0390],
    [0.0522, -0.0235, 0.0345], [0.1165, -0.0264, 0.0306]
  ],
  // Rios: polilinhas da nascente (pé do maciço) até além da foz — o
  // sentido dos pontos é o da correnteza
  rivers: [
    // Norte (tronco que sai do colo do maciço)
    [[-0.0021, -0.0062], [-0.0347, -0.0495], [-0.0492, -0.1361], [-0.0713, -0.1902], [-0.1090, -0.2320], [-0.1556, -0.2641]],
    // Noroeste (braço que se separa do rio norte)
    [[-0.0588, -0.1592], [-0.1316, -0.1665], [-0.2181, -0.1511], [-0.2528, -0.1591], [-0.2761, -0.1737], [-0.3333, -0.2523]],
    // Sudoeste (braço que contorna o maciço pelo oeste)
    [[-0.0347, -0.0495], [-0.0799, -0.0468], [-0.1170, -0.0347], [-0.1662, -0.0083], [-0.1990, 0.0771], [-0.2298, 0.1212], [-0.2284, 0.1632], [-0.2915, 0.2620]],
    // Nordeste
    [[0.1269, -0.0398], [0.1298, -0.0726], [0.1405, -0.0857], [0.2014, -0.1067], [0.2450, -0.1353], [0.2892, -0.1542]],
    // Sul
    [[0.0360, 0.0294], [0.0370, 0.0731], [0.0456, 0.0893], [0.0980, 0.1235], [0.1067, 0.1379], [0.1099, 0.2288], [0.1391, 0.3265]]
  ]
};

const S = WORLD_SIZE;
const COAST_R0 = ISLAND.coastR0 * S;
const COAST_H = ISLAND.coastHarm.map(([a, b]) => [a * S, b * S]);
const SPINE = ISLAND.mountSpine.map((p) => p.map((v) => v * S));
const RIVER_SEGS = [];
for (const line of ISLAND.rivers) {
  for (let i = 0; i < line.length - 1; i++) {
    RIVER_SEGS.push([line[i][0] * S, line[i][1] * S, line[i + 1][0] * S, line[i + 1][1] * S]);
  }
}

// Meandros: o domínio é deformado por senoides antes de medir a distância
// às polilinhas — os trechos retos do traçado viram curvas de rio
const warpX = (z) => Math.sin(z * 0.042 + 0.4) * 8.0 + Math.cos(z * 0.09) * 2.5;
const warpZ = (x) => Math.sin(x * 0.038 + 1.7) * 8.0 + Math.cos(x * 0.083) * 2.5;

// Raio da costa (m) na direção de (x,z). cos(kθ)/sin(kθ) saem por
// recorrência a partir de (x,z)/r — sem trigonometria
export function coastRadius(x, z) {
  const r = Math.max(Math.hypot(x, z), 1e-3);
  const c1 = x / r, s1 = z / r;
  let ck = c1, sk = s1, R = COAST_R0;
  for (let k = 0; k < COAST_H.length; k++) {
    R += COAST_H[k][0] * ck + COAST_H[k][1] * sk;
    const t = ck * c1 - sk * s1;
    sk = sk * c1 + ck * s1;
    ck = t;
  }
  return R;
}

// Distância com sinal (m) à borda do maciço: negativa dentro da mancha
export function mountSdf(x, z) {
  let best = 1e9;
  for (let i = 0; i < SPINE.length - 1; i++) {
    const a = SPINE[i], b = SPINE[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
    const d = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) - (a[2] + (b[2] - a[2]) * t);
    if (d < best) best = d;
  }
  return best;
}

// Distância (m) ao eixo do rio mais próximo
export function riverDist(x, z) {
  const qx = x + warpX(z), qz = z + warpZ(x);
  let best = 1e18;
  for (let i = 0; i < RIVER_SEGS.length; i++) {
    const s = RIVER_SEGS[i];
    const dx = s[2] - s[0], dz = s[3] - s[1];
    const t = Math.min(1, Math.max(0, ((qx - s[0]) * dx + (qz - s[1]) * dz) / (dx * dx + dz * dz)));
    const ex = qx - s[0] - dx * t, ez = qz - s[1] - dz * t;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// Ponto do eixo de um rio: u em [0,1) escolhe o trecho e a posição nele
export function riverPoint(u) {
  const f = u * RIVER_SEGS.length;
  const i = Math.min(RIVER_SEGS.length - 1, Math.floor(f));
  const s = RIVER_SEGS[i], t = f - i;
  const px = s[0] + (s[2] - s[0]) * t, pz = s[1] + (s[3] - s[1]) * t;
  return [px - warpX(pz), pz - warpZ(px)]; // desfaz a deformação dos meandros (1ª ordem)
}

// Ponto de partida: margem do rio sul logo abaixo do maciço, olhando rio
// acima. `focus` é o centro da clareira, `cam` a posição inicial da câmera
function computeSpawn() {
  const line = ISLAND.rivers[4];
  const ax = line[2][0] * S, az = line[2][1] * S, bx = line[3][0] * S, bz = line[3][1] * S;
  const len = Math.hypot(bx - ax, bz - az);
  const tx = (bx - ax) / len, tz = (bz - az) / len; // correnteza
  const nx = -tz, nz = tx;                          // margem direita de quem desce o rio
  const bank = (along, target) => {
    const px = ax + tx * along, pz = az + tz * along;
    for (let off = 0; off < 90; off += 0.5) {
      const x = px + nx * off, z = pz + nz * off;
      if (riverDist(x, z) >= target) return [x, z];
    }
    return [px + nx * target, pz + nz * target];
  };
  const focus = bank(len * 0.62, 15.0);
  const cam = bank(len * 0.62 + 22.0, 13.0);
  const fx = -tx - nx * 0.35, fz = -tz - nz * 0.35;
  return { focus, cam, yaw: Math.atan2(fx, fz) };
}
export const ISLAND_SPAWN = computeSpawn();

// ----------------------------------------------------------------------------
// Espelho WGSL das funções acima, gerado dos mesmos dados (interpolado em
// WGSL_SHADERS) — a água enxerga exatamente a mesma planta do relevo
// ----------------------------------------------------------------------------
const num = (v) => v.toFixed(3);
const v2 = (x, z) => `vec2<f32>(${num(x)}, ${num(z)})`;

export const ISLAND_WGSL = /* wgsl */`
  // Raio da costa (m) — coastRadius do island.js
  fn islandCoastR(p: vec2<f32>) -> f32 {
    let r = max(length(p), 0.001);
    let c1 = p.x / r;
    let s1 = p.y / r;
    var ck = c1;
    var sk = s1;
    var t = 0.0;
    var R = ${num(COAST_R0)};
${COAST_H.map(([a, b]) => `    R += ${num(a)} * ck + ${num(b)} * sk; t = ck * c1 - sk * s1; sk = sk * c1 + ck * s1; ck = t;`).join('\n')}
    return R;
  }

  fn islandCapsule(p: vec2<f32>, a: vec3<f32>, b: vec3<f32>) -> f32 {
    let ab = b.xy - a.xy;
    let h = clamp(dot(p - a.xy, ab) / dot(ab, ab), 0.0, 1.0);
    return length(p - a.xy - ab * h) - mix(a.z, b.z, h);
  }

  // Distância com sinal (m) à borda do maciço — mountSdf do island.js
  fn islandMountSdf(p: vec2<f32>) -> f32 {
    var d = 1e9;
${SPINE.slice(0, -1).map((a, i) => {
    const b = SPINE[i + 1];
    return `    d = min(d, islandCapsule(p, vec3<f32>(${num(a[0])}, ${num(a[1])}, ${num(a[2])}), vec3<f32>(${num(b[0])}, ${num(b[1])}, ${num(b[2])})));`;
  }).join('\n')}
    return d;
  }

  // best: xy = direção do trecho mais próximo, z = distância² a ele
  fn islandRiverSeg(q: vec2<f32>, a: vec2<f32>, b: vec2<f32>, best: vec3<f32>) -> vec3<f32> {
    let ab = b - a;
    let h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
    let e = q - a - ab * h;
    let d2 = dot(e, e);
    if (d2 < best.z) { return vec3<f32>(ab, d2); }
    return best;
  }

  // Rio mais próximo — riverDist do island.js: xy = sentido da correnteza
  // (unitário, da nascente para a foz), z = distância ao eixo (m)
  fn islandRiver(p: vec2<f32>) -> vec3<f32> {
    let q = p + vec2<f32>(
      sin(p.y * 0.042 + 0.4) * 8.0 + cos(p.y * 0.09) * 2.5,
      sin(p.x * 0.038 + 1.7) * 8.0 + cos(p.x * 0.083) * 2.5
    );
    var best = vec3<f32>(0.0, 1.0, 1e18);
${RIVER_SEGS.map((s) => `    best = islandRiverSeg(q, ${v2(s[0], s[1])}, ${v2(s[2], s[3])}, best);`).join('\n')}
    // O trecho é reto no domínio deformado: trazido de volta pela inversa do
    // jacobiano dos meandros, o sentido acompanha cada curva do leito
    let wxDz = cos(p.y * 0.042 + 0.4) * 0.336 - sin(p.y * 0.09) * 0.225;
    let wzDx = cos(p.x * 0.038 + 1.7) * 0.304 - sin(p.x * 0.083) * 0.2075;
    var dir = vec2<f32>(best.x - wxDz * best.y, best.y - wzDx * best.x);
    // Sempre para o mar: a planta ordena nascente→foz; se a deformação
    // inverter localmente, corrige pelo radial para fora (costa = |p|↑)
    if (dot(dir, p) < 0.0) { dir = -dir; }
    return vec3<f32>(normalize(dir), sqrt(best.z));
  }
`;
