// ============================================================================
// world.js — Geração Procedural de Terreno, Árvores Seculares, Copas em
// Camadas, Samambaias, Grama, Troncos Caídos e Cogumelos Bioluminescentes
// ============================================================================

import { PRNG, ProceduralNoise } from './math.js';
import { WORLD_SIZE, ISLAND_SPAWN, coastRadius, mountSdf, riverDist, riverPoint } from './island.js';

const smooth01 = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3.0 - 2.0 * c); };

// Grade de células (GRID_N × GRID_N sobre o worldSize) que organiza as
// instâncias: cada buffer sai ordenado por célula, e o renderer desenha só
// as faixas das células visíveis — é o que permite mata fechada na ilha
// inteira sem pagar por ela a cada frame
export const GRID_N = 80;

// Lista de instâncias (8 floats: x, y, z, escala, rotY, fase, tint, vento)
// que guarda também a célula de cada uma
class InstanceList {
  constructor(capacity) {
    this.data = new Float32Array(Math.max(16, capacity) * 8);
    this.cell = new Uint16Array(Math.max(16, capacity));
    this.count = 0;
  }
  push(cell, x, y, z, scale, rotY, phase, tint, wind) {
    if (this.count === this.cell.length) {
      const data = new Float32Array(this.data.length * 2); data.set(this.data); this.data = data;
      const cells = new Uint16Array(this.cell.length * 2); cells.set(this.cell); this.cell = cells;
    }
    const o = this.count * 8, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = scale;
    d[o + 4] = rotY; d[o + 5] = phase; d[o + 6] = tint; d[o + 7] = wind;
    this.cell[this.count++] = cell;
  }
  // Ordena por célula (counting sort estável). starts[c]..starts[c+1] é a
  // faixa de instâncias da célula c no buffer final
  pack(cellCount) {
    const starts = new Uint32Array(cellCount + 1);
    for (let i = 0; i < this.count; i++) starts[this.cell[i] + 1]++;
    for (let c = 0; c < cellCount; c++) starts[c + 1] += starts[c];
    const cursor = starts.slice(0, cellCount);
    const data = new Float32Array(this.count * 8);
    for (let i = 0; i < this.count; i++) {
      const o = cursor[this.cell[i]]++ * 8;
      for (let k = 0; k < 8; k++) data[o + k] = this.data[i * 8 + k];
    }
    return { data, starts, count: this.count };
  }
}

export class ForestWorld {
  constructor(seed = 2026) {
    this.seed = seed;
    this.noise = new ProceduralNoise(seed);
    this.worldSize = WORLD_SIZE; // ilha ~2.2km × 1.65km + margem de fundo marinho
    this.waterLevel = -2.38;
    this.oceanSize = 7000.0; // o plano de água vai além do terreno, até o horizonte
    // Clareira de partida na margem do rio sul, ao pé do maciço
    this.focus = ISLAND_SPAWN.focus;
    this.spawn = ISLAND_SPAWN;
  }

  // Distância à costa (m, positiva terra adentro): o contorno da planta
  // (island.js) é deformado por fbm de baixa frequência — enseadas e pontas
  // miúdas sobre o desenho da ilha.
  // (espelhada no islandShore do shader de água — manter sincronizada)
  shoreDist(x, z) {
    const n = this.noise.fbm(x * 0.0035 + 6.7, z * 0.0035 - 1.9, 3);
    return coastRadius(x, z) * (1.0 + (n - 0.5) * 0.09) - Math.hypot(x, z);
  }

  // Fator de transição floresta (0) -> maciço central (1): sobe do sopé,
  // ~78m fora da mancha do maciço, até o miolo ~91m para dentro da borda
  mountMask(x, z) {
    const S = this.worldSize;
    return smooth01((S * 0.03 - mountSdf(x, z)) / (S * 0.065));
  }

  // Distância (m) ao eixo do rio mais próximo da rede (island.js)
  riverDist(x, z) {
    return riverDist(x, z);
  }

  // Meia-largura do leito plano: os rios alargam ao se aproximar da foz
  // (≥14 m para a malha ~5 m/célula ter vários vértices sob a água)
  riverCore(shore) {
    return 14.0 + 6.0 * (1.0 - smooth01(shore / (this.worldSize * 0.07)));
  }

  // Canal do rio: leito escavado abaixo do nível d'água (-2.38), com
  // margens suaves — água corrente contínua da nascente até o mar
  riverMask(x, z) {
    const core = this.riverCore(this.shoreDist(x, z));
    return 1.0 - smooth01((riverDist(x, z) - core) / 9.0);
  }

  // Densidade de mata (0..1): floresta fechada na ilha inteira, da orla da
  // praia ao sopé do maciço — só clareiras miúdas e raras (nunca em volta
  // do ponto de partida). Compartilhada pelas instâncias e pela cor do terreno.
  forestDensity(x, z) {
    const S = this.worldSize;
    const g = this.noise.fbm(x * 0.014 + 31.7, z * 0.014 - 12.3, 3);
    const glade = smooth01((g - 0.82) / 0.05); // ~5% da área, clareiras pequenas
    const dFocus = Math.hypot(x - this.focus[0], z - this.focus[1]);
    const core = 1.0 - smooth01((dFocus - S * 0.05) / (S * 0.06));
    return Math.max(core, 1.0 - glade * 0.7);
  }

  // FBM amortecido por derivada (terrainH/terrainM do shader fdlyW4, iq):
  // cada oitava é atenuada por 1/(1+‖∇acumulado‖²), o que esculpe cristas
  // agudas e vertentes erodidas — a assinatura do relevo de montanha do iq.
  // Domínio ~0.006 (λ0 ≈ 165m) adaptado do 0.003/SC do shader à escala do mapa
  mountainIq(x, z) {
    let px = x * 0.006 + 13.7;
    let pz = z * 0.006 - 4.2;
    let a = 0.0, b = 1.0, dx = 0.0, dz = 0.0;
    for (let i = 0; i < 12; i++) {
      const n = this.noise.noised2(px, pz);
      dx += n[1]; dz += n[2];
      a += b * n[0] / (1.0 + dx * dx + dz * dz);
      b *= 0.5;
      // p = m2·p·2 com m2 = rotação (0.8, 0.6) — quebra alinhamento axial
      const qx = 0.8 * px + 0.6 * pz;
      const qz = -0.6 * px + 0.8 * pz;
      px = qx * 2.0; pz = qz * 2.0;
    }
    return a; // ~0..1.1
  }

  // Mapa unificado da ilha: maciço central (estilo fdlyW4 do iq) cercado
  // de floresta baixa, rios que descem do sopé até o mar e praia em toda a
  // volta — transição contínua
  getTerrainHeight(x, z) {
    const S = this.worldSize;
    const mask = this.mountMask(x, z);
    const distFromFocus = Math.hypot(x - this.focus[0], z - this.focus[1]);

    // Chão da floresta: clareira + micro-relevo
    const clearing = Math.min(1.0, Math.max(0.0, (distFromFocus - 7.0) / 24.0));
    const base = this.noise.fbm(x * 0.017 + 11.3, z * 0.017 - 7.1, 5);
    const detail = this.noise.fbm(x * 0.08, z * 0.08, 3) * 0.25;
    const fRidge = this.noise.ridge(x * 0.011 + 3.4, z * 0.011 + 9.2, 4) * 0.52;
    let forestH = (base * 15.0 + detail * 4.8 + fRidge * 8.5 - 6.8) * (0.32 + 0.68 * clearing);
    // Piso suave acima do nível do mar: as baixadas da mata viram brejo
    // raso, nunca covas secas abaixo da linha d'água
    if (forestH < -1.2) forestH = -1.2 + (forestH + 1.2) * 0.15;

    // Maciço: fbm com amortecimento por derivada (estilo fdlyW4 do iq) —
    // picos erodidos com cristas agudas — + volume largo de fbm no sopé.
    // O pedestal garante que a mancha inteira do maciço se ergue da mata
    let h = forestH;
    if (mask > 0.0) {
      const massif = this.noise.fbm(x * 0.007 + 3.1, z * 0.007 - 8.4, 4);
      const mountH = this.mountainIq(x, z) * 95.0 + massif * 14.0 + 26.0;
      h = forestH * (1.0 - mask) + mountH * mask;
    }

    const shore = this.shoreDist(x, z);

    // Restinga: da borda da mata o relevo desce a uma planície arenosa baixa
    // que margeia a ilha inteira — a faixa de praia propriamente dita.
    // O peso 1-(1-p)² achata depressa: os últimos ~80m de terra são praia
    // plana de verdade, enquanto a parte interna guarda o relevo da mata
    const plainS = smooth01(1.0 - shore / (S * 0.06));
    if (plainS > 0.0) {
      const plainW = 1.0 - (1.0 - plainS) * (1.0 - plainS);
      const beachH = 1.5 - 2.1 * plainS + (this.noise.fbm(x * 0.055 + 2.2, z * 0.055 - 4.4, 3) - 0.5) * 1.7;
      h = h * (1.0 - plainW) + beachH * plainW;
    }

    // Rios: nascem rasos no pé do maciço, cortam a floresta e atravessam a
    // praia num canal de maré até o oceano — leito contínuo. Cada rio corre
    // numa várzea baixa (margens suaves em vez de barrancos)
    const rd = riverDist(x, z);
    const core = this.riverCore(shore);
    if (rd < core + 64.0 && mask < 1.0) {
      // O canal corta o sopé e só some bem dentro do maciço (mask≳0.9)
      const dry = 1.0 - smooth01((mask - 0.45) / 0.45);
      const valley = (1.0 - smooth01((rd - core - 14.0) / 50.0)) * dry;
      // Margens da várzea: um pouco acima da linha d'água (−2.38)
      const flood = -0.55 + (this.noise.fbm(x * 0.085 + 4.1, z * 0.085 - 2.8, 3) - 0.5) * 0.9;
      h = h * (1.0 - valley) + Math.min(h, flood) * valley;
      const rMask = (1.0 - smooth01((rd - core) / 8.0)) * dry;
      if (rMask > 0.0) {
        // Leito em declive contínuo da nascente à foz, SEMPRE ≥1.5 m
        // abaixo da linha d'água (−2.38): ~−3.9 na nascente → ~−5.3 na
        // orla — corpo d'água largo e correnteza ao mar (espelhado em
        // waterDepthAt)
        let bedY = -5.3 + 1.4 * smooth01(Math.max(0.0, shore) / (S * 0.15));
        bedY += (this.noise.fbm(x * 0.055 + 5.5, z * 0.055 - 3.1, 3) - 0.5) * 0.2;
        bedY += (1.0 - smooth01(mountSdf(x, z) / (S * 0.045))) * 0.2;
        bedY = Math.min(bedY, this.waterLevel - 1.5);
        h = h * (1.0 - rMask) + bedY * rMask;
      }
      // Trava: no miolo do canal a malha nunca fura o plano d'água
      // (triângulos das margens não podem empurrar vértices para cima)
      if (rd < core * 0.9 && dry > 0.4) {
        h = Math.min(h, this.waterLevel - 1.0);
      }
    }

    // Ilha: o terreno mergulha sob o mar além da faixa costeira
    const seaMask = smooth01(-shore / (S * 0.04));
    if (seaMask > 0.0) {
      const seaBed = -6.8 + this.noise.fbm(x * 0.15 - 2.0, z * 0.15 + 4.0, 3) * 1.2;
      h = h * (1.0 - seaMask) + seaBed * seaMask;
      // Mergulho extra no meio da faixa costeira: garante linha de praia
      // definida (morros rasos viram maré, não ilhotas rascantes)
      h -= seaMask * (1.0 - seaMask) * 10.0;
    }
    return h;
  }

  getTerrainNormal(x, z) {
    const e = 0.3;
    const hL = this.getTerrainHeight(x - e, z);
    const hR = this.getTerrainHeight(x + e, z);
    const hD = this.getTerrainHeight(x, z - e);
    const hU = this.getTerrainHeight(x, z + e);
    const nx = hL - hR;
    const ny = 2.0 * e;
    const nz = hD - hU;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }

  // Alturas dos vértices da malha de resolução `res` (NaN = por calcular).
  // O buildTerrainMesh deixa a grade pronta: com centenas de milhares de
  // instâncias na ilha inteira, recalculá-la dobraria o tempo de geração
  heightCache(res) {
    if (!this.heightGrid || this.heightGrid.res !== res) {
      this.heightGrid = { res, data: new Float32Array(res * res).fill(NaN) };
    }
    return this.heightGrid.data;
  }

  // Altura do terreno exatamente como renderizada: mesma grade e mesma
  // triangulação (a,c,b)+(b,c,d) do buildTerrainMesh. A função analítica
  // pode ficar acima da malha em regiões convexas — instâncias apoiadas
  // na altura analítica flutuam. `cache` memoiza as alturas dos vértices.
  getMeshHeight(x, z, res, cache) {
    const size = this.worldSize, half = size * 0.5, n = res - 1;
    const step = size / n;
    const gx = Math.min(Math.max((x + half) / step, 0), n - 1e-6);
    const gz = Math.min(Math.max((z + half) / step, 0), n - 1e-6);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const gridH = (j, i) => {
      const key = i * res + j;
      let h = cache[key];
      if (h !== h) { // NaN = vértice ainda não calculado
        h = this.getTerrainHeight(-half + j * step, -half + i * step);
        cache[key] = h;
      }
      return h;
    };
    const hA = gridH(ix, iz), hB = gridH(ix + 1, iz);
    const hC = gridH(ix, iz + 1), hD = gridH(ix + 1, iz + 1);
    if (fx + fz <= 1.0) return hA + (hB - hA) * fx + (hC - hA) * fz;
    return hD + (hB - hD) * (1.0 - fz) + (hC - hD) * (1.0 - fx);
  }

  // Material IDs: 0 = Terreno/Musgo, 1 = Casca A, 2 = Folhagem/Copa,
  // 3 = Samambaia/Grama, 4 = Rocha, 5 = Cogumelo, 6 = Água, 7 = Folha redonda,
  // 8 = Casca B (emergente), 9 = Tronco caído
  buildTerrainMesh(resolution) {
    const size = this.worldSize;
    const half = size * 0.5;
    const vertCount = resolution * resolution;
    // Stride: pos(3), normal(3), color(3), uv(2), matId(1) = 12 floats
    const vertices = new Float32Array(vertCount * 12);
    const indices = new Uint32Array((resolution - 1) * (resolution - 1) * 6);
    this.heightGrid = { res: resolution, data: new Float32Array(vertCount) };
    const heights = this.heightGrid.data;

    let ptr = 0;
    for (let iz = 0; iz < resolution; iz++) {
      const vz = iz / (resolution - 1);
      const z = -half + vz * size;
      for (let ix = 0; ix < resolution; ix++) {
        const vx = ix / (resolution - 1);
        const x = -half + vx * size;
        const y = this.getTerrainHeight(x, z);
        heights[iz * resolution + ix] = y;
        const [nx, ny, nz] = this.getTerrainNormal(x, z);

        const mossNoise = this.noise.fbm(x * 0.085 + 4.1, z * 0.085 - 2.8, 4);
        const litterNoise = this.noise.noise2D(x * 0.32, z * 0.32);
        const slope = 1.0 - ny;

        const mask = this.mountMask(x, z);
        const shore = this.shoreDist(x, z);
        // Areia: toda a orla — cheia nos ~20m junto ao mar, sumindo sob a
        // mata ~78m terra adentro (e seguindo mar adentro, no fundo raso)
        const coastM = smooth01((size * 0.03 - shore) / (size * 0.022));
        const mT = Math.min(1, Math.max(0, (mask - 0.05) / 0.65));
        const mountBlend = mT * mT * (3.0 - 2.0 * mT);
        // Campo aberto entre os capões de mata: gramado em vez de serrapilheira
        const meadow = (1.0 - this.forestDensity(x, z)) * (1.0 - mountBlend) * (1.0 - coastM);
        let meadowAmt = 0.0;
        let r, g, b;
        if (y < -2.35) {
          // Leito submerso: seixos no rio, areia escura sob o mar
          r = 0.06 + coastM * 0.16; g = 0.09 + coastM * 0.14; b = 0.08 + coastM * 0.05;
        } else {
          // Cor base do vale: encosta rochosa / chão de floresta + prado alpino
          if (slope > 0.22) {
            const rockMix = Math.min(1.0, (slope - 0.22) * 3.5);
            r = 0.16 * (1 - rockMix) + 0.14 * rockMix;
            g = 0.12 * (1 - rockMix) + 0.14 * rockMix;
            b = 0.08 * (1 - rockMix) + 0.13 * rockMix;
          } else {
            // Fundo de vale: musgo + serrapilheira
            const m = Math.max(0, Math.min(1, mossNoise * 1.4 - 0.15));
            let fr = (0.17 * (1 - m) + 0.07 * m) + litterNoise * 0.045;
            let fg = (0.12 * (1 - m) + 0.23 * m) + litterNoise * 0.04;
            let fb = (0.06 * (1 - m) + 0.07 * m) + litterNoise * 0.015;
            const patch = this.noise.fbm(x * 0.045 + 7.7, z * 0.045 - 3.2, 3);
            const litter = Math.max(0, Math.min(1, (patch - 0.52) * 2.4)) * 0.72 * (1.0 - mask);
            fr = fr * (1 - litter) + 0.135 * litter;
            fg = fg * (1 - litter) + 0.105 * litter;
            fb = fb * (1 - litter) + 0.052 * litter;
            // Campo: verde de capim, mais claro que o chão sombreado da mata
            meadowAmt = meadow;
            const gz = meadowAmt * 0.85;
            fr = fr * (1 - gz) + (0.115 + litterNoise * 0.05) * gz;
            fg = fg * (1 - gz) + (0.215 + mossNoise * 0.07) * gz;
            fb = fb * (1 - gz) + 0.055 * gz;
            r = fr; g = fg; b = fb;
          }

          // Maciço: paleta do shader fdlyW4 (iq) — rocha escura, scree ocre
          // nas concavidades, prado nos topos planos e neve por alt+declive
          if (mountBlend > 0.0) {
            const rN = this.noise.fbm(x * 0.035 + 2.9, z * 0.035 - 1.3, 4);
            // Variação macro vertical: estirada em y → bandas suaves de rocha
            const strata = this.noise.fbm(x * 0.004 + 9.0, y * 0.22, 3);
            const rockLum = (rN * 0.25 + 0.75) * 0.9;
            let mr = rockLum * (0.24 + 0.10 * strata);
            let mg = rockLum * (0.13 + 0.13 * strata);
            let mb = rockLum * (0.07 + 0.15 * strata);

            // Scree ocre acumulado nas vertentes mais suaves (nor.y ~0.7-0.9)
            const scree = Math.min(1, Math.max(0, (ny - 0.70) / 0.20));
            const screeLum = 0.5 + 0.5 * rN;
            mr = mr * (1 - scree) + 0.30 * screeLum * scree;
            mg = mg * (1 - scree) + 0.19 * screeLum * scree;
            mb = mb * (1 - scree) + 0.09 * screeLum * scree;

            // Prado alpino esverdeado só nos planaltos (nor.y ~1)
            const mead = Math.min(1, Math.max(0, (ny - 0.95) / 0.05));
            const meadLum = 0.25 + 0.75 * rN;
            mr = mr * (1 - mead) + 0.18 * meadLum * mead;
            mg = mg * (1 - mead) + 0.18 * meadLum * mead;
            mb = mb * (1 - mead) + 0.06 * meadLum * mead;

            // Patchwork macro de luminosidade (o "0.1+1.8·√(fbm·fbm)" do iq)
            const macro = 0.20 + 1.45 * Math.sqrt(
              this.noise.fbm(x * 0.06 + 0.7, z * 0.06 - 1.1, 4) *
              this.noise.fbm(x * 0.008 + 5.5, z * 0.008 + 8.8, 3)
            );
            mr *= macro; mg *= macro; mb *= macro;

            // Neve: linha de neve ruidosa (~106-128m: só os cumes do maciço) +
            // exigência de encosta suave + quebra direcional — neve se
            // acumula, não cobre penhasco
            const snowN = this.noise.fbm(x * 0.014 + 1.7, z * 0.014 - 6.2, 4);
            const hSnow = Math.min(1, Math.max(0, (y + 22.0 * snowN - 128.0) / 30.0));
            // Em altitude alta a neve pega até encostas íngremes (eT0 cai a 0.37)
            const eT0 = 0.92 - 0.55 * hSnow, eT1 = 0.97 - 0.15 * hSnow;
            const eSnow = Math.min(1, Math.max(0, (ny - eT0) / Math.max(eT1 - eT0, 1e-4)));
            const oSnow = 0.3 + 0.7 * Math.min(1, Math.max(0, (nx + hSnow * hSnow) / 0.1));
            const sSnow = hSnow * eSnow * oSnow;
            const snowM = Math.min(1, Math.max(0, (sSnow - 0.1) / 0.8));
            mr = mr * (1 - snowM) + 0.70 * snowM;
            mg = mg * (1 - snowM) + 0.75 * snowM;
            mb = mb * (1 - snowM) + 0.85 * snowM;

            r = r * (1 - mountBlend) + mr * mountBlend;
            g = g * (1 - mountBlend) + mg * mountBlend;
            b = b * (1 - mountBlend) + mb * mountBlend;
          }
        }

        // Praia: a restinga baixa vira areia clara dourada perto da linha
        // d'água, clareando até sob a lâmina (areia molhada do baixio)
        const sandWin = Math.min(1, Math.max(0, 1.4 * (1.0 - Math.abs(y + 0.8) / 4.2)));
        const beachAmt = coastM * sandWin * 0.92;
        r = r * (1 - beachAmt) + 0.46 * beachAmt;
        g = g * (1 - beachAmt) + 0.38 * beachAmt;
        b = b * (1 - beachAmt) + 0.20 * beachAmt;

        // Variação micro de luminosidade do solo
        const micro = 0.88 + this.noise.noise2D(x * 0.9 + 3.1, z * 0.9 - 1.7) * 0.24;
        r *= micro; g *= micro; b *= micro;

        vertices[ptr++] = x;
        vertices[ptr++] = y;
        vertices[ptr++] = z;
        vertices[ptr++] = nx;
        vertices[ptr++] = ny;
        vertices[ptr++] = nz;
        vertices[ptr++] = r;
        vertices[ptr++] = g;
        vertices[ptr++] = b;
        // O uv do terreno não mapeia textura (o shader projeta por worldPos):
        // leva as máscaras de cobertura — x = areia de praia, y = campo aberto
        vertices[ptr++] = beachAmt;
        vertices[ptr++] = meadowAmt;
        vertices[ptr++] = 0.0; // Material Terreno
      }
    }

    let iPtr = 0;
    for (let iz = 0; iz < resolution - 1; iz++) {
      for (let ix = 0; ix < resolution - 1; ix++) {
        const a = iz * resolution + ix;
        const b = a + 1;
        const c = (iz + 1) * resolution + ix;
        const d = c + 1;
        indices[iPtr++] = a; indices[iPtr++] = c; indices[iPtr++] = b;
        indices[iPtr++] = b; indices[iPtr++] = c; indices[iPtr++] = d;
      }
    }

    return { vertices, indices };
  }

  // Plano contínuo de água em y = waterLevel — cobre rio e o oceano
  // inteiro ao redor da ilha (bem maior que a malha de terreno)
  buildWaterMesh(resolution = 96) {
    const size = this.oceanSize;
    const half = size * 0.5;
    const waterLevel = this.waterLevel;
    const vertices = new Float32Array(resolution * resolution * 12);
    const indices = new Uint32Array((resolution - 1) * (resolution - 1) * 6);

    let ptr = 0;
    for (let iz = 0; iz < resolution; iz++) {
      const vz = iz / (resolution - 1);
      const z = -half + vz * size;
      for (let ix = 0; ix < resolution; ix++) {
        const vx = ix / (resolution - 1);
        const x = -half + vx * size;
        vertices[ptr++] = x;
        vertices[ptr++] = waterLevel;
        vertices[ptr++] = z;
        vertices[ptr++] = 0.0;
        vertices[ptr++] = 1.0;
        vertices[ptr++] = 0.0;
        vertices[ptr++] = 0.03;
        vertices[ptr++] = 0.09;
        vertices[ptr++] = 0.08;
        vertices[ptr++] = vx * 40.0;
        vertices[ptr++] = vz * 40.0;
        vertices[ptr++] = 6.0; // Material Água
      }
    }

    let iPtr = 0;
    for (let iz = 0; iz < resolution - 1; iz++) {
      for (let ix = 0; ix < resolution - 1; ix++) {
        const a = iz * resolution + ix;
        const b = a + 1;
        const c = (iz + 1) * resolution + ix;
        const d = c + 1;
        indices[iPtr++] = a; indices[iPtr++] = c; indices[iPtr++] = b;
        indices[iPtr++] = b; indices[iPtr++] = c; indices[iPtr++] = d;
      }
    }
    return { vertices, indices };
  }

  // Árvore ancestral com sapopembas (raízes tabulares), tronco tortuoso e galhos primários/secundários
  // variant 0: copaíba robusta e tortuosa | variant 1: emergente alta e esbelta
  // lod 1: só o fuste em 40 triângulos — árvores além do alcance de detalhe
  buildTreeTrunkMesh(variant = 0, lod = 0) {
    const isSlim = variant === 1;
    const treeHeight = isSlim ? 21.0 : 16.5;
    const baseRadius = isSlim ? 0.50 : 0.68;
    const taperPow = isSlim ? 1.02 : 1.12;
    const flareStrength = isSlim ? 0.32 : 0.75;
    const swayX = isSlim ? 0.28 : 0.45;
    const swayZ = isSlim ? 0.22 : 0.36;
    const barkBase = isSlim ? [0.12, 0.11, 0.09] : [0.15, 0.11, 0.08];
    const positions = [];
    const normals = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    const addBranch = (points, radii, radialSegs, flareStrength = 0.0) => {
      const baseVertex = positions.length / 3;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const r = radii[i];
        const v = i / (points.length - 1);

        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        let tx = next[0] - prev[0], ty = next[1] - prev[1], tz = next[2] - prev[2];
        const tLen = Math.hypot(tx, ty, tz) || 1;
        tx /= tLen; ty /= tLen; tz /= tLen;

        let upX = Math.abs(ty) > 0.9 ? 1 : 0;
        let upY = Math.abs(ty) > 0.9 ? 0 : 1;
        let bx = ty * 0 - tz * upY;
        let by = tz * upX - tx * 0;
        let bz = tx * upY - ty * upX;
        const bLen = Math.hypot(bx, by, bz) || 1;
        bx /= bLen; by /= bLen; bz /= bLen;

        const nx0 = by * tz - bz * ty;
        const ny0 = bz * tx - bx * tz;
        const nz0 = bx * ty - by * tx;

        for (let s = 0; s <= radialSegs; s++) {
          const u = s / radialSegs;
          const theta = u * Math.PI * 2.0;

          // Sapopembas (raízes tabulares) pronunciadas na base do tronco
          let flare = 1.0;
          if (flareStrength > 0 && v < 0.28) {
            const rootT = 1.0 - v / 0.28;
            const buttress = Math.pow(Math.max(0, Math.cos(theta * 5.0 + 0.4)), 2.0);
            flare += flareStrength * rootT * rootT * (0.35 + 0.85 * buttress);
          }

          // Sulcos profundos na casca
          const barkGroove = 1.0 + 0.08 * Math.sin(theta * 9.0 + v * 16.0) + 0.04 * Math.cos(theta * 17.0 - v * 9.0);
          const rad = r * flare * barkGroove;

          const cosT = Math.cos(theta), sinT = Math.sin(theta);
          const nx = nx0 * cosT + bx * sinT;
          const ny = ny0 * cosT + by * sinT;
          const nz = nz0 * cosT + bz * sinT;

          positions.push(p[0] + nx * rad, p[1] + ny * rad, p[2] + nz * rad);
          normals.push(nx, ny, nz);

          // Casca marrom-acinzentada rica com transição de musgo na base
          const mossFactor = Math.max(0, (1.0 - v * 2.1) * 0.65);
          const cr = barkBase[0] * (1 - mossFactor) + 0.07 * mossFactor;
          const cg = barkBase[1] * (1 - mossFactor) + 0.21 * mossFactor;
          const cb = barkBase[2] * (1 - mossFactor) + 0.06 * mossFactor;
          colors.push(cr, cg, cb);
          uvs.push(u * 3.0, v * 8.0);
        }
      }

      const ringStride = radialSegs + 1;
      for (let i = 0; i < points.length - 1; i++) {
        for (let s = 0; s < radialSegs; s++) {
          const a = baseVertex + i * ringStride + s;
          const b = a + 1;
          const c = baseVertex + (i + 1) * ringStride + s;
          const d = c + 1;
          indices.push(a, b, c, b, d, c);
        }
      }
    };

    const trunkPts = [];
    const trunkRadii = [];
    const steps = lod ? 4 : 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = Math.sin(t * 3.3) * swayX * t;
      const sz = Math.cos(t * 2.5) * swayZ * t;
      trunkPts.push([sx, t * treeHeight, sz]);
      trunkRadii.push(baseRadius * Math.pow(1.0 - t * 0.80, taperPow));
    }
    if (lod) {
      // De longe as sapopembas e os galhos somem sob a copa: fuste liso,
      // um pouco mais grosso para manter a silhueta
      addBranch(trunkPts, trunkRadii.map((r) => r * 1.2), 5, 0.0);
      return this.packMesh(positions, normals, colors, uvs, indices, isSlim ? 8.0 : 1.0);
    }
    addBranch(trunkPts, trunkRadii, 14, flareStrength);

    // Galhos primários: a copaíba ramifica cedo e baixo; a emergente só no topo
    const branchConfigs = isSlim ? [
      { startT: 0.62, angle: 0.6, len: 4.4, pitch: 0.55 },
      { startT: 0.70, angle: 2.4, len: 4.6, pitch: 0.52 },
      { startT: 0.77, angle: 4.3, len: 4.0, pitch: 0.60 },
      { startT: 0.84, angle: 1.5, len: 3.4, pitch: 0.68 },
      { startT: 0.90, angle: 3.6, len: 2.8, pitch: 0.74 }
    ] : [
      { startT: 0.44, angle: 0.2, len: 5.0, pitch: 0.48 },
      { startT: 0.52, angle: 2.1, len: 5.4, pitch: 0.45 },
      { startT: 0.60, angle: 4.1, len: 4.8, pitch: 0.52 },
      { startT: 0.68, angle: 1.1, len: 4.2, pitch: 0.58 },
      { startT: 0.76, angle: 3.2, len: 3.6, pitch: 0.65 },
      { startT: 0.84, angle: 5.2, len: 2.9, pitch: 0.72 }
    ];

    for (const cfg of branchConfigs) {
      const idx = Math.floor(cfg.startT * steps);
      const origin = trunkPts[idx];
      const bPts = [];
      const bRad = [];
      const bSteps = 6;
      const dx = Math.cos(cfg.angle);
      const dz = Math.sin(cfg.angle);
      for (let i = 0; i <= bSteps; i++) {
        const t = i / bSteps;
        const reach = t * cfg.len;
        const lift = Math.sin(t * Math.PI * 0.62) * cfg.len * cfg.pitch;
        bPts.push([origin[0] + dx * reach, origin[1] + lift, origin[2] + dz * reach]);
        bRad.push(0.24 * (1.0 - t * 0.84));
      }
      addBranch(bPts, bRad, 7, 0.0);

      // Sub-galho bifurcado
      const midOrigin = bPts[3];
      const subPts = [];
      const subRad = [];
      const subAngle = cfg.angle + 0.65;
      const sdx = Math.cos(subAngle);
      const sdz = Math.sin(subAngle);
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        subPts.push([
          midOrigin[0] + sdx * t * (cfg.len * 0.55),
          midOrigin[1] + t * (cfg.len * 0.35),
          midOrigin[2] + sdz * t * (cfg.len * 0.55)
        ]);
        subRad.push(0.11 * (1.0 - t * 0.85));
      }
      addBranch(subPts, subRad, 5, 0.0);
    }

    // matId 8 = casca da espécie B (emergente esbelta, textura de casca rachada)
    return this.packMesh(positions, normals, colors, uvs, indices, isSlim ? 8.0 : 1.0);
  }

  // Copa multicamadas composta por dezenas de raminhos/folhas cruzadas em 3D (substitui esferas simples)
  // variant 0: folha lanceolada verde-viva | variant 1: folha arredondada verde-oliva (matId 7)
  // lod 1: as mesmas folhas em cartões planos (2 triângulos cada; o recorte
  // vem do alpha test) — 6× mais leve, para a meia distância e as sombras
  // lod 2: ramalhete distante — menos cartões, maiores — para as copas além
  // do alcance de detalhe
  buildCanopyClusterMesh(variant = 0, lod = 0) {
    const positions = [];
    const normals = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    const isRound = variant === 1;
    const rng = new PRNG(9012);
    // ramalhetes pequenos com orientação variada = massa de folhagem densa
    const leafCards = lod === 2 ? 26 : (isRound ? 44 : 54);

    for (let c = 0; c < leafCards; c++) {
      // Distribuição esférica Fibonacci com jitter radial orgânico
      const y = 1 - (c / (leafCards - 1)) * 2;
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = c * 2.399963229728653;

      const cx = Math.cos(theta) * radiusAtY * 1.15 + rng.range(-0.16, 0.16);
      const cy = y * 0.78 + rng.range(-0.10, 0.10);
      const cz = Math.sin(theta) * radiusAtY * 1.15 + rng.range(-0.16, 0.16);

      // Normal base apontando para fora do centro da copa
      const nLen = Math.hypot(cx, cy + 0.35, cz) || 1;
      const nx = cx / nLen;
      const ny = (cy + 0.35) / nLen;
      const nz = cz / nLen;

      // Inclinação aleatória da normal: quebra o facetamento radial uniforme
      const tilt = 0.6;
      let n2x = nx + rng.range(-tilt, tilt);
      let n2y = ny + rng.range(-tilt, tilt) * 0.65;
      let n2z = nz + rng.range(-tilt, tilt);
      const n2Len = Math.hypot(n2x, n2y, n2z) || 1;
      n2x /= n2Len; n2y /= n2Len; n2z /= n2Len;

      // Base ortonormal do cartão + rotação livre em torno da normal
      let tx = -n2z, ty = 0, tz = n2x;
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen; tz /= tLen;
      let bx = n2y * tz - n2z * ty;
      let by = n2z * tx - n2x * tz;
      let bz = n2x * ty - n2y * tx;
      const roll = rng.range(0, Math.PI * 2);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const t2x = tx * cr + bx * sr, t2y = ty * cr + by * sr, t2z = tz * cr + bz * sr;
      const b2x = -tx * sr + bx * cr, b2y = -ty * sr + by * cr, b2z = -tz * sr + bz * cr;

      const cardScale = (isRound ? rng.range(0.28, 0.46) : rng.range(0.30, 0.52)) * (lod === 2 ? 1.5 : 1.0);
      const sunGrad = Math.max(0, Math.min(1, y * 0.5 + 0.55));
      // Variação de matiz: verde profundo -> verde-lima / verde-oliva, com folhas secas ocasionais
      const warm = rng.next();
      const dry = rng.next() < 0.10;
      const r = (isRound ? 0.065 : 0.05) + sunGrad * (isRound ? 0.13 : 0.11) + warm * 0.035 + (dry ? 0.10 : 0) + rng.range(-0.01, 0.015);
      const g = (isRound ? 0.13 : 0.14) + sunGrad * (isRound ? 0.25 : 0.27) + rng.range(-0.02, 0.035) + (dry ? 0.02 : 0);
      const b = (isRound ? 0.035 : 0.04) + sunGrad * 0.045 + rng.range(-0.008, 0.008) - (dry ? 0.012 : 0);

      const baseV = positions.length / 3;
      if (lod) {
        // Cartão plano: um quad cobrindo a folha inteira (o uv 0..1 leva a
        // silhueta, que no detalhe cheio vem em parte do afilamento da malha)
        const hw = isRound ? 0.40 : 0.30;
        const lz0 = isRound ? -0.40 : -0.55, lz1 = isRound ? 0.55 : 0.85;
        for (const [lx, lz, u, v] of [[-hw, lz0, 0.0, 0.02], [hw, lz0, 1.0, 0.02], [-hw, lz1, 0.0, 1.0], [hw, lz1, 1.0, 1.0]]) {
          positions.push(
            cx + (t2x * lx + n2x * 0.05 + b2x * lz) * cardScale,
            cy + (t2y * lx + n2y * 0.05 + b2y * lz) * cardScale,
            cz + (t2z * lx + n2z * 0.05 + b2z * lz) * cardScale
          );
          normals.push(n2x, n2y, n2z);
          colors.push(r, g, b);
          uvs.push(u, v);
        }
        indices.push(baseV, baseV + 1, baseV + 2, baseV + 1, baseV + 2, baseV + 3);
        continue;
      }
      // Grade 3x4 por folha: nervura central elevada (dobra em V), asas caem nas
      // bordas e a ponta curva para baixo — shading suave em vez de facetas planas
      const rows = isRound ? [
        // [lz, halfW, midY, edgeY, uvY]
        [-0.40, 0.10, 0.02, 0.00, 0.02],
        [-0.10, 0.40, 0.10, 0.045, 0.35],
        [ 0.25, 0.32, 0.09, 0.02, 0.70],
        [ 0.55, 0.015, -0.07, -0.07, 1.0],
      ] : [
        [-0.55, 0.11, 0.02, 0.00, 0.02],
        [-0.15, 0.36, 0.11, 0.035, 0.32],
        [ 0.25, 0.32, 0.10, 0.015, 0.68],
        [ 0.85, 0.015, -0.10, -0.10, 1.0],
      ];

      for (let rI = 0; rI < rows.length; rI++) {
        const [lz, hw, midY, edgeY, v] = rows[rI];
        // Inclinação de dobra (dy/dx) e de curvatura ao longo do comprimento (dy/dz)
        const fold = (midY - edgeY) / Math.max(hw, 0.02);
        const prevY = rI > 0 ? rows[rI - 1][2] : midY;
        const nextY = rI < rows.length - 1 ? rows[rI + 1][2] : midY;
        const prevZ = rI > 0 ? rows[rI - 1][0] : lz;
        const nextZ = rI < rows.length - 1 ? rows[rI + 1][0] : lz;
        const slopeZ = (nextY - prevY) / Math.max(nextZ - prevZ, 0.01);

        const cols = [[-hw, edgeY, 0.0, fold], [0.0, midY, 0.5, 0.0], [hw, edgeY, 1.0, -fold]];
        for (const [lx, ly, u, dydx] of cols) {
          const px = cx + (t2x * lx + n2x * ly + b2x * lz) * cardScale;
          const py = cy + (t2y * lx + n2y * ly + b2y * lz) * cardScale;
          const pz = cz + (t2z * lx + n2z * ly + b2z * lz) * cardScale;

          // Normal local (-dydx, 1, -dydz) transformada para o espaço do cartão
          let vnx = t2x * -dydx + n2x + b2x * -slopeZ;
          let vny = t2y * -dydx + n2y + b2y * -slopeZ;
          let vnz = t2z * -dydx + n2z + b2z * -slopeZ;
          const vnLen = Math.hypot(vnx, vny, vnz) || 1;
          normals.push(vnx / vnLen, vny / vnLen, vnz / vnLen);
          positions.push(px, py, pz);
          colors.push(r, g, b);
          uvs.push(u, v);
        }
      }

      for (let rI = 0; rI < rows.length - 1; rI++) {
        const a = baseV + rI * 3;
        const b2 = baseV + (rI + 1) * 3;
        indices.push(
          a + 0, a + 1, b2 + 0,
          a + 1, b2 + 0, b2 + 1,
          a + 1, a + 2, b2 + 1,
          a + 2, b2 + 1, b2 + 2
        );
      }
    }

    return this.packMesh(positions, normals, colors, uvs, indices, isRound ? 7.0 : 2.0);
  }

  // Samambaia arqueada detalhada com múltiplos segmentos por fronde
  buildFernMesh() {
    const positions = [];
    const normals = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    const fronds = 9;
    const segs = 5;
    for (let f = 0; f < fronds; f++) {
      const angle = (f / fronds) * Math.PI * 2.0 + (f % 2) * 0.22;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const px = -dz;
      const pz = dx;
      const baseV = positions.length / 3;
      const len = 1.05 + (f % 3) * 0.22;

      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const reach = t * len;
        const archY = Math.sin(t * Math.PI * 0.74) * 0.75;
        const width = Math.sin(t * Math.PI) * 0.26 + 0.015;

        const cx = dx * reach;
        const cz = dz * reach;

        // 3 vértices transversais por segmento para dobra V natural da folha
        const offsets = [
          { side: -1, drop: -0.03, u: 0.0 },
          { side: 0,  drop: 0.02,  u: 0.5 },
          { side: 1,  drop: -0.03, u: 1.0 }
        ];
        for (const o of offsets) {
          positions.push(cx + px * width * o.side, archY + o.drop, cz + pz * width * o.side);
          normals.push(dx * 0.25 + px * o.side * 0.35, 0.9, dz * 0.25 + pz * o.side * 0.35);
          colors.push(0.08 + t * 0.13, 0.24 + t * 0.26, 0.06 + t * 0.05);
          uvs.push(o.u, t);
        }
      }

      for (let s = 0; s < segs; s++) {
        const r0 = baseV + s * 3;
        const r1 = baseV + (s + 1) * 3;
        indices.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
        indices.push(r0 + 1, r1 + 1, r0 + 2, r0 + 2, r1 + 1, r1 + 2);
      }
    }

    return this.packMesh(positions, normals, colors, uvs, indices, 3.0);
  }

  // Tufo de grama silvestre alta para cobrir clareiras e margens do rio
  buildGrassMesh() {
    const positions = [];
    const normals = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    const blades = 7;
    const rng = new PRNG(4411);
    for (let b = 0; b < blades; b++) {
      const ang = (b / blades) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const ox = Math.cos(ang) * rng.range(0.02, 0.16);
      const oz = Math.sin(ang) * rng.range(0.02, 0.16);
      const bendX = Math.cos(ang) * rng.range(0.15, 0.42);
      const bendZ = Math.sin(ang) * rng.range(0.15, 0.42);
      const h = rng.range(0.45, 0.85);
      const w = 0.032;

      const px = -Math.sin(ang);
      const pz = Math.cos(ang);
      const baseV = positions.length / 3;

      const levels = [
        { t: 0.0, width: w, y: 0.0, bx: 0, bz: 0 },
        { t: 0.55, width: w * 0.65, y: h * 0.55, bx: bendX * 0.35, bz: bendZ * 0.35 },
        { t: 1.0, width: 0.002, y: h, bx: bendX, bz: bendZ }
      ];

      for (const lv of levels) {
        for (const side of [-1, 1]) {
          positions.push(ox + lv.bx + px * lv.width * side, lv.y, oz + lv.bz + pz * lv.width * side);
          normals.push(0, 1, 0);
          colors.push(0.09 + lv.t * 0.16, 0.22 + lv.t * 0.28, 0.06 + lv.t * 0.05);
          uvs.push(side * 0.5 + 0.5, lv.t);
        }
      }
      indices.push(
        baseV + 0, baseV + 2, baseV + 1,
        baseV + 1, baseV + 2, baseV + 3,
        baseV + 2, baseV + 4, baseV + 3,
        baseV + 3, baseV + 4, baseV + 5
      );
    }

    return this.packMesh(positions, normals, colors, uvs, indices, 3.0);
  }

  // Rocha facetada com musgo no topo
  buildRockMesh() {
    const t = (1 + Math.sqrt(5)) / 2;
    const rawVerts = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ];
    const rawFaces = [
      [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
      [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
      [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
      [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
    ];

    const midCache = new Map();
    const verts = rawVerts.map(v => {
      const l = Math.hypot(v[0], v[1], v[2]);
      return [v[0]/l, v[1]/l, v[2]/l];
    });
    const getMid = (i1, i2) => {
      const key = i1 < i2 ? `${i1}_${i2}` : `${i2}_${i1}`;
      if (midCache.has(key)) return midCache.get(key);
      const v1 = verts[i1], v2 = verts[i2];
      const m = [(v1[0]+v2[0])*0.5, (v1[1]+v2[1])*0.5, (v1[2]+v2[2])*0.5];
      const l = Math.hypot(m[0], m[1], m[2]);
      const idx = verts.length;
      verts.push([m[0]/l, m[1]/l, m[2]/l]);
      midCache.set(key, idx);
      return idx;
    };

    const faces = [];
    for (const [a, b, c] of rawFaces) {
      const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
      faces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }

    const positions = [], normals = [], colors = [], uvs = [], indices = [];
    for (let i = 0; i < verts.length; i++) {
      const [nx, ny, nz] = verts[i];
      const facet = 0.78 + 0.34 * Math.abs(Math.sin(nx * 4.1 + nz * 3.3)) * Math.cos(ny * 3.7);
      positions.push(nx * facet * 1.2, ny * facet * 0.72, nz * facet * 1.1);
      normals.push(nx, ny, nz);

      const moss = Math.max(0, Math.min(1, (ny - 0.12) * 1.9));
      colors.push(
        0.16 * (1 - moss) + 0.07 * moss,
        0.18 * (1 - moss) + 0.24 * moss,
        0.19 * (1 - moss) + 0.08 * moss
      );
      uvs.push(nx * 0.5 + 0.5, nz * 0.5 + 0.5);
    }
    for (const f of faces) indices.push(f[0], f[1], f[2]);

    return this.packMesh(positions, normals, colors, uvs, indices, 4.0);
  }

  // Tronco caído decomposto no chão da floresta
  buildFallenLogMesh() {
    const positions = [], normals = [], colors = [], uvs = [], indices = [];
    const segs = 10;
    const radSegs = 10;
    const len = 5.2;

    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = (t - 0.5) * len;
      const y = 0.24 + Math.sin(t * Math.PI) * 0.06;
      const z = Math.sin(t * 2.5) * 0.18;
      const r = 0.32 * (1.0 - t * 0.25);

      for (let s = 0; s <= radSegs; s++) {
        const u = s / radSegs;
        const theta = u * Math.PI * 2.0;
        const ny = Math.sin(theta);
        const nz = Math.cos(theta);
        const groove = 1.0 + 0.07 * Math.sin(theta * 8.0 + t * 14.0);

        positions.push(x, y + ny * r * groove, z + nz * r * groove);
        normals.push(0.0, ny, nz);

        // Topo coberto por musgo espesso
        const moss = Math.max(0, ny * 1.2);
        colors.push(
          0.14 * (1 - moss) + 0.07 * moss,
          0.10 * (1 - moss) + 0.23 * moss,
          0.07 * (1 - moss) + 0.06 * moss
        );
        uvs.push(t * 5.0, u * 2.0);
      }
    }

    const stride = radSegs + 1;
    for (let i = 0; i < segs; i++) {
      for (let s = 0; s < radSegs; s++) {
        const a = i * stride + s;
        const b = a + 1;
        const c = (i + 1) * stride + s;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    // matId 9 = tronco caído (textura de madeira)
    return this.packMesh(positions, normals, colors, uvs, indices, 9.0);
  }

  // Cogumelos florestais / bioluminescentes (caule + chapéu)
  buildMushroomMesh() {
    const positions = [], normals = [], colors = [], uvs = [], indices = [];
    const rings = [
      { y: 0.0,  r: 0.035, col: [0.65, 0.72, 0.62] },
      { y: 0.14, r: 0.028, col: [0.70, 0.78, 0.68] },
      { y: 0.22, r: 0.025, col: [0.55, 0.85, 0.72] },
      { y: 0.21, r: 0.16,  col: [0.35, 0.95, 0.78] },
      { y: 0.27, r: 0.13,  col: [0.45, 1.00, 0.82] },
      { y: 0.31, r: 0.05,  col: [0.55, 1.00, 0.88] },
      { y: 0.32, r: 0.001, col: [0.65, 1.00, 0.92] }
    ];
    const segs = 10;
    for (let i = 0; i < rings.length; i++) {
      const rg = rings[i];
      for (let s = 0; s <= segs; s++) {
        const u = s / segs;
        const th = u * Math.PI * 2;
        const nx = Math.cos(th);
        const nz = Math.sin(th);
        positions.push(nx * rg.r, rg.y, nz * rg.r);
        normals.push(nx * 0.7, i >= 3 ? 0.7 : 0.1, nz * 0.7);
        colors.push(rg.col[0], rg.col[1], rg.col[2]);
        uvs.push(u, i / (rings.length - 1));
      }
    }
    const stride = segs + 1;
    for (let i = 0; i < rings.length - 1; i++) {
      for (let s = 0; s < segs; s++) {
        const a = i * stride + s;
        const b = a + 1;
        const c = (i + 1) * stride + s;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    return this.packMesh(positions, normals, colors, uvs, indices, 5.0);
  }

  packMesh(positions, normals, colors, uvs, indices, matId) {
    const vCount = positions.length / 3;
    const vertices = new Float32Array(vCount * 12);
    for (let i = 0; i < vCount; i++) {
      vertices[i * 12 + 0] = positions[i * 3 + 0];
      vertices[i * 12 + 1] = positions[i * 3 + 1];
      vertices[i * 12 + 2] = positions[i * 3 + 2];
      vertices[i * 12 + 3] = normals[i * 3 + 0];
      vertices[i * 12 + 4] = normals[i * 3 + 1];
      vertices[i * 12 + 5] = normals[i * 3 + 2];
      vertices[i * 12 + 6] = colors[i * 3 + 0];
      vertices[i * 12 + 7] = colors[i * 3 + 1];
      vertices[i * 12 + 8] = colors[i * 3 + 2];
      vertices[i * 12 + 9] = uvs[i * 2 + 0];
      vertices[i * 12 + 10] = uvs[i * 2 + 1];
      vertices[i * 12 + 11] = matId;
    }
    return { vertices, indices: new Uint32Array(indices) };
  }

  generateInstances(preset) {
    const rng = new PRNG(this.seed);
    const S = this.worldSize;
    const half = S * 0.46;
    const res = preset.terrainRes;
    const meshCache = this.heightCache(res);

    // Células em ordem de linha (z) × coluna (x), e a faixa de altura
    // ocupada em cada uma (vira a esfera de culling do renderer)
    const cellSize = S / GRID_N, cellCount = GRID_N * GRID_N;
    const cellAxis = (v) => Math.min(GRID_N - 1, Math.max(0, Math.floor((v + S * 0.5) / cellSize)));
    const cellMinY = new Float32Array(cellCount).fill(1e9);
    const cellMaxY = new Float32Array(cellCount).fill(-1e9);
    const cellOf = (x, y, z) => {
      const cell = cellAxis(z) * GRID_N + cellAxis(x);
      if (y < cellMinY[cell]) cellMinY[cell] = y;
      if (y > cellMaxY[cell]) cellMaxY[cell] = y;
      return cell;
    };

    const trunksA = new InstanceList(preset.trees);
    const trunksB = new InstanceList(preset.trees >> 1);
    const canopiesA = new InstanceList(preset.foliageClusters);
    const canopiesB = new InstanceList(preset.foliageClusters >> 1);
    const canopiesAFar = new InstanceList(preset.trees * 4);
    const canopiesBFar = new InstanceList(preset.trees * 2);
    const ferns = new InstanceList(preset.ferns);
    const grasses = new InstanceList(preset.grassTufts);
    const rocks = new InstanceList(preset.rocks * 2);
    const logs = new InstanceList(preset.fallenLogs);
    const mushrooms = new InstanceList(preset.mushrooms);

    // Sorteia um ponto da ilha proporcionalmente à densidade de mata
    // (rejeição sobre candidatos uniformes): sub-bosque e troncos caídos
    // acompanham a floresta e rareiam nas clareiras
    const spot = [0, 0];
    const pickForest = (tries) => {
      for (let t = 0; t < tries; t++) {
        spot[0] = rng.range(-half, half);
        spot[1] = rng.range(-half, half);
        if (rng.next() < this.forestDensity(spot[0], spot[1])) return true;
      }
      return false;
    };

    // Espaçamento mínimo entre troncos: grade com no máximo uma árvore por
    // casa (lado = distância/√2) — basta olhar as 5×5 casas vizinhas
    const minGap = 3.2, occSize = minGap / Math.SQRT2, occN = Math.ceil(S / occSize);
    const occX = new Float32Array(occN * occN).fill(NaN);
    const occZ = new Float32Array(occN * occN);
    const occAxis = (v) => Math.min(occN - 1, Math.max(0, Math.floor((v + S * 0.5) / occSize)));
    const crowded = (x, z) => {
      const ox = occAxis(x), oz = occAxis(z);
      for (let j = Math.max(0, oz - 2); j <= Math.min(occN - 1, oz + 2); j++) {
        for (let i = Math.max(0, ox - 2); i <= Math.min(occN - 1, ox + 2); i++) {
          const px = occX[j * occN + i];
          if (px === px && Math.hypot(px - x, occZ[j * occN + i] - z) < minGap) return true;
        }
      }
      return false;
    };

    // 1. Árvores Gigantes + Copas Multicamadas — mata fechada na ilha
    // inteira, da orla da praia ao sopé do maciço (linha das árvores
    // natural por altitude), aberta só pelas clareiras e pelos rios
    const treeTarget = preset.trees;
    const clustersPerTree = Math.max(8, Math.floor(preset.foliageClusters / preset.trees));
    const viewX = Math.sin(this.spawn.yaw), viewZ = Math.cos(this.spawn.yaw);
    let placedTrees = 0;
    let attempts = 0;
    while (placedTrees < treeTarget && attempts < treeTarget * 40) {
      attempts++;
      const x = rng.range(-half, half);
      const z = rng.range(-half, half);
      if (rng.next() >= this.forestDensity(x, z)) continue;
      const dFocus = Math.hypot(x - this.focus[0], z - this.focus[1]);
      // Mantém vista frontal da clareira e o leito do rio livres
      if (dFocus < 9.5) continue;
      // Idem para a câmera inicial: nenhum tronco colado nela nem no
      // corredor do olhar (que abre um pouco com a distância)
      const sdx = x - this.spawn.cam[0], sdz = z - this.spawn.cam[1];
      const sAlong = sdx * viewX + sdz * viewZ;
      if (Math.hypot(sdx, sdz) < 7.0) continue;
      if (sAlong > 0.0 && sAlong < 45.0 && Math.abs(sdx * viewZ - sdz * viewX) < 4.0 + sAlong * 0.08) continue;
      if (this.shoreDist(x, z) < S * 0.028) continue; // praia aberta: sem floresta
      if (this.riverMask(x, z) > 0.45) continue; // tronco não nasce dentro d'água
      if (crowded(x, z)) continue;
      const y = this.getMeshHeight(x, z, res, meshCache);
      if (y < -2.1) continue;
      if (y > 14.0) continue; // linha das árvores por altitude
      const tn = this.getTerrainNormal(x, z);
      if (1.0 - tn[1] > 0.28) continue; // encostas íngremes sem árvores
      // Árvores menores e um pouco mais ralas conforme sobem a encosta
      if (y > 8.0 && rng.next() < 0.35) continue;

      const scale = rng.range(0.78, 1.62) * (1.0 - Math.max(0, y - 6.0) * 0.05);
      const rotY = rng.range(0, Math.PI * 2);
      const phase = rng.range(0, 100);
      const tint = rng.range(0.82, 1.22);

      // Duas espécies: 68% copaíba robusta (A), 32% emergente esbelta (B)
      const treeType = rng.next() < 0.68 ? 0 : 1;
      const treeH = treeType === 1 ? 21.0 : 16.5;
      const cell = cellOf(x, y, z);
      occX[occAxis(z) * occN + occAxis(x)] = x;
      occZ[occAxis(z) * occN + occAxis(x)] = z;
      // windWeight 0.0: o vento balança apenas a folhagem, nunca o tronco
      (treeType === 1 ? trunksB : trunksA).push(cell, x, y - 0.45, z, scale, rotY, phase, tint, 0.0);
      placedTrees++;

      // As copas entram na célula do tronco: a árvore inteira troca de
      // nível de detalhe de uma vez
      const canopyArr = treeType === 1 ? canopiesB : canopiesA;
      for (let c = 0; c < clustersPerTree; c++) {
        const isCrown = treeType === 1 ? c < 7 : c < 4;
        const angle = (c / clustersPerTree) * Math.PI * 2 + rotY + rng.range(-0.45, 0.45);
        const dist = treeType === 1
          ? (isCrown ? rng.range(0.3, 1.7) * scale : rng.range(1.7, 3.4) * scale)
          : (isCrown ? rng.range(0.3, 2.2) * scale : rng.range(2.2, 5.4) * scale);
        const hFrac = treeType === 1
          ? (isCrown ? rng.range(0.90, 1.06) : rng.range(0.60, 0.90))
          : (isCrown ? rng.range(0.86, 1.05) : rng.range(0.50, 0.88));
        const cx = x + Math.cos(angle) * dist;
        const cz = z + Math.sin(angle) * dist;
        const cy = y + treeH * scale * hFrac;
        const cScale = treeType === 1 ? rng.range(1.35, 2.2) * scale : rng.range(1.55, 2.65) * scale;

        canopyArr.push(cell, cx, cy, cz, cScale, rng.range(0, Math.PI * 2), phase + c * 0.65, rng.range(0.75, 1.32), 1.0);
      }

      // Copa distante (LOD): um ramalhete grande no topo + uma coroa deles
      // em volta, ocupando o mesmo volume das dezenas de ramalhetes cheios
      const farArr = treeType === 1 ? canopiesBFar : canopiesAFar;
      const farCount = treeType === 1 ? 3 : 4;
      for (let c = 0; c < farCount; c++) {
        const angle = rotY + c * (Math.PI * 2 / (farCount - 1));
        const dist = c === 0 ? 0.0 : (treeType === 1 ? 2.1 : 3.9) * scale;
        const hFrac = treeType === 1 ? (c === 0 ? 0.97 : 0.76) : (c === 0 ? 0.93 : 0.70);
        farArr.push(cell,
          x + Math.cos(angle) * dist, y + treeH * scale * hFrac, z + Math.sin(angle) * dist,
          (treeType === 1 ? 2.9 : 3.4) * scale,
          rotY + c * 2.1, phase + c * 0.65, 0.88 + 0.3 * ((phase * 0.37 + c * 0.31) % 1), 1.0);
      }
    }

    // 2. Samambaias — sub-bosque úmido: só onde há mata (fora da areia)
    for (let i = preset.ferns * 8; i > 0 && ferns.count < preset.ferns; i--) {
      if (!pickForest(1)) continue;
      const x = spot[0], z = spot[1];
      if (this.shoreDist(x, z) < S * 0.028) continue;
      if (this.riverMask(x, z) > 0.35) continue;
      const y = this.getMeshHeight(x, z, res, meshCache);
      if (y < -2.25 || y > 11.0) continue;
      const density = this.noise.noise2D(x * 0.11 + 20, z * 0.11 - 15);
      if (density < 0.30 && rng.next() > 0.22) continue;

      ferns.push(cellOf(x, y, z), x, y - 0.04, z, rng.range(0.65, 1.6), rng.range(0, Math.PI * 2), rng.range(0, 100), rng.range(0.8, 1.25), 0.85);
    }

    // 3. Tufos de Grama Alta — chão da mata, clareiras e prados do sopé
    for (let i = preset.grassTufts * 8; i > 0 && grasses.count < preset.grassTufts; i--) {
      const x = rng.range(-half, half), z = rng.range(-half, half);
      if (this.shoreDist(x, z) < S * 0.01) continue; // areia nua junto ao mar
      if (this.riverMask(x, z) > 0.35) continue; // grama não nasce no leito
      const y = this.getMeshHeight(x, z, res, meshCache);
      if (y < -2.3 || y > 18.0) continue;
      grasses.push(cellOf(x, y, z), x, y - 0.03, z, rng.range(0.75, 1.55), rng.range(0, Math.PI * 2), rng.range(0, 100), rng.range(0.8, 1.3), 1.15);
    }

    // 4. Rochas — pequenas na mata/margens dos rios, blocos grandes nas encostas.
    // Apoio físico: a base afunda sob o ponto mais baixo amostrado na
    // projeção da rocha sobre a malha renderizada — nunca fica no ar.
    const rockTarget = Math.floor(preset.rocks * 1.6);
    for (let i = 0; i < rockTarget; i++) {
      const nearStream = i < rockTarget * 0.35;
      let x, z;
      if (nearStream) {
        const rp = riverPoint(rng.next());
        x = rp[0] + rng.range(-8.0, 8.0);
        z = rp[1] + rng.range(-8.0, 8.0);
      } else {
        // Em terra ou no raso da orla: mar aberto não leva blocos soltos
        for (let t = 0; t < 4; t++) {
          x = rng.range(-half, half);
          z = rng.range(-half, half);
          if (this.shoreDist(x, z) > -S * 0.015) break;
        }
      }
      if (Math.hypot(x - this.focus[0], z - this.focus[1]) < 5.0) continue;
      const mask = this.mountMask(x, z);
      const scale = rng.range(0.55, 2.3) * (1.0 + mask * 1.4);
      const fr = 1.05 * scale; // raio útil da projeção (~0.8 do raio do mesh)
      let minH = this.getMeshHeight(x, z, res, meshCache), maxH = minH;
      for (let s = 0; s < 16; s++) {
        const rr = s < 12 ? fr : fr * 0.5;
        const a = (s % 12) * (Math.PI / 6) + (s >= 12 ? Math.PI / 12 : 0);
        const h = this.getMeshHeight(x + Math.cos(a) * rr, z + Math.sin(a) * rr, res, meshCache);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
      // Vertente íngreme demais: um bloco solto não repousaria ali
      if (maxH - minH > 1.5 * scale) continue;
      // Base do mesh ≈ -0.56·scale: o fundo fica ~0.26·scale sob o ponto
      // mais baixo e a aba do elipsoide toca o solo na borda da projeção
      rocks.push(cellOf(x, minH, z), x, minH + 0.30 * scale, z,
        scale, rng.range(0, Math.PI * 2), 0, rng.range(0.85, 1.15), 0.0);
    }

    // 5. Troncos Caídos + Aglomerados de Cogumelos Bioluminescentes (só na mata)
    const colonyCount = Math.max(4, Math.floor(preset.mushrooms / preset.fallenLogs));
    for (let i = preset.fallenLogs * 8; i > 0 && logs.count < preset.fallenLogs; i--) {
      if (!pickForest(1)) continue;
      const x = spot[0], z = spot[1];
      if (Math.hypot(x - this.focus[0], z - this.focus[1]) < 7.5) continue;
      if (this.shoreDist(x, z) < S * 0.028) continue;
      const y = this.getMeshHeight(x, z, res, meshCache);
      if (y < -2.1 || y > 12.0) continue;
      const rotY = rng.range(0, Math.PI * 2);
      const lScale = rng.range(0.85, 1.35);
      // O tronco é rígido: repousa sobre o contato mais alto ao longo do
      // seu comprimento e pontea depressões rasas, como um tronco real
      const ldx = Math.cos(rotY) * 2.2 * lScale, ldz = Math.sin(rotY) * 2.2 * lScale;
      let maxH = y;
      for (const t of [-1, -0.5, 0.5, 1]) {
        const h = this.getMeshHeight(x + ldx * t, z + ldz * t, res, meshCache);
        if (h > maxH) maxH = h;
      }
      const cell = cellOf(x, maxH, z);
      logs.push(cell, x, maxH - 0.14 * lScale, z, lScale, rotY, 0, rng.range(0.85, 1.15), 0.0);

      // Colônia de cogumelos ao redor e sobre o tronco caído
      for (let m = 0; m < colonyCount; m++) {
        const along = rng.range(-2.2, 2.2);
        const side = rng.range(-0.65, 0.65);
        const mx = x + Math.cos(rotY) * along - Math.sin(rotY) * side;
        const mz = z + Math.sin(rotY) * along + Math.cos(rotY) * side;
        const my = this.getMeshHeight(mx, mz, res, meshCache);
        mushrooms.push(cell, mx, my - 0.02, mz, rng.range(0.6, 1.5), rng.range(0, Math.PI * 2), rng.range(0, 50), 1.0, 0.0);
      }
    }

    // 6. Esporos e Vagalumes
    const spores = new Float32Array(preset.spores * 4);
    for (let i = 0; i < preset.spores; i++) {
      const x = rng.range(-half * 0.85, half * 0.85);
      const z = rng.range(-half * 0.85, half * 0.85);
      const y = this.getTerrainHeight(x, z) + rng.range(0.5, 16.0);
      spores[i * 4 + 0] = x;
      spores[i * 4 + 1] = y;
      spores[i * 4 + 2] = z;
      spores[i * 4 + 3] = rng.range(0, Math.PI * 2);
    }

    // Esfera envolvente de cada célula: o piso ocupado + a altura das
    // árvores e a copa que avança sobre as vizinhas (raio 0 = célula vazia)
    const centerY = new Float32Array(cellCount);
    const radius = new Float32Array(cellCount);
    for (let c = 0; c < cellCount; c++) {
      if (cellMinY[c] > cellMaxY[c]) continue;
      const spanY = (cellMaxY[c] - cellMinY[c]) * 0.5;
      centerY[c] = cellMinY[c] + spanY + 17.0;
      radius[c] = Math.hypot(cellSize * Math.SQRT1_2 + 13.0, spanY + 20.0);
    }

    // Cada lista sai ordenada por célula, com a tabela de faixas em grid.starts
    const out = {
      spores, sporeCount: preset.spores,
      grid: {
        n: GRID_N, cellSize, centerY, radius, starts: {},
        detailDist: preset.treeDetailDist, lodDist: preset.treeLodDist, understoryDist: preset.understoryDist
      }
    };
    const lists = {
      trunksA: [trunksA, 'trunkACount'], trunksB: [trunksB, 'trunkBCount'],
      canopiesA: [canopiesA, 'canopyACount'], canopiesB: [canopiesB, 'canopyBCount'],
      canopiesAFar: [canopiesAFar, 'canopyAFarCount'], canopiesBFar: [canopiesBFar, 'canopyBFarCount'],
      ferns: [ferns, 'fernCount'], grasses: [grasses, 'grassCount'],
      rocks: [rocks, 'rockCount'], logs: [logs, 'logCount'], mushrooms: [mushrooms, 'mushroomCount']
    };
    for (const name in lists) {
      const packed = lists[name][0].pack(cellCount);
      out[name] = packed.data;
      out[lists[name][1]] = packed.count;
      out.grid.starts[name] = packed.starts;
    }
    return out;
  }
}