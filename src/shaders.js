// ============================================================================
// shaders.js — Shaders PBR Cook-Torrance GGX, Shadow Mapping PCF 3x3,
// Céu Atmosférico com Nuvens Procedurais, Sombras de Nuvens e Estrelas,
// Volumetric God Rays Raymarching e Pós-Processamento HDR Bloom (WGSL)
// ============================================================================

import { ISLAND_WGSL } from './island.js';

export const WGSL_SHADERS = /* wgsl */`
  struct FrameUniforms {
    viewProj: mat4x4<f32>,
    invViewProj: mat4x4<f32>,
    lightViewProj: mat4x4<f32>,
    cameraPos: vec4<f32>, // w: seed do mundo (hash do leito no shader de água)
    sunDir: vec4<f32>,    // w: alcance do sub-bosque em metros (fade no vsInstanced)
    sunColor: vec4<f32>,
    skyTopColor: vec4<f32>,
    skyHorizonColor: vec4<f32>,
    fogColor: vec4<f32>,
    params: vec4<f32>,  // x: time, y: windStrength, z: fogDensity, w: sunElevation
    params2: vec4<f32>, // x: godRaySteps, y: bloomThreshold, z: shadowBias, w: aspect
  };

  @group(0) @binding(0) var<uniform> frame: FrameUniforms;
  @group(0) @binding(1) var shadowMap: texture_depth_2d;
  @group(0) @binding(2) var shadowSampler: sampler_comparison;
  // Texturas fotográficas (pacote de mídia do Shadertoy — CC BY-NC-SA)
  @group(0) @binding(3) var texBark: texture_2d<f32>;
  @group(0) @binding(4) var texRock: texture_2d<f32>;
  @group(0) @binding(5) var texGround: texture_2d<f32>;
  @group(0) @binding(6) var texNoise: texture_2d<f32>;
  @group(0) @binding(7) var texStars: texture_2d<f32>;
  @group(0) @binding(9) var texLitter: texture_2d<f32>;
  @group(0) @binding(10) var texWet: texture_2d<f32>;
  @group(0) @binding(11) var texTwigs: texture_2d<f32>;
  @group(0) @binding(12) var texBark2: texture_2d<f32>;
  @group(0) @binding(13) var texGranite: texture_2d<f32>;
  @group(0) @binding(14) var texGray: texture_2d<f32>;
  @group(0) @binding(15) var texWood: texture_2d<f32>;
  @group(0) @binding(16) var texSand: texture_2d<f32>;
  @group(0) @binding(8) var texSamp: sampler;

  // Amostra sRGB -> linear (LOD explícito: seguro dentro de branches por material)
  fn texLin(t: texture_2d<f32>, uv: vec2<f32>) -> vec3<f32> {
    let c = textureSampleLevel(t, texSamp, uv, 0.0).rgb;
    return pow(c, vec3<f32>(2.2));
  }

  struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) matId: f32,
  };

  struct InstanceInput {
    @location(5) instPosScale: vec4<f32>, // xyz: pos, w: scale
    @location(6) instMeta: vec4<f32>,     // x: rotY, y: windPhase, z: tint, w: windWeight
  };

  struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) worldPos: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) matId: f32,
    @location(5) hueJit: f32,
  };

  // --- RUÍDO PROCEDURAL 3D PARA MICRO-DETALHES PBR ---
  fn hash31(p: vec3<f32>) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Interpolação quíntica (6t⁵−15t⁴+10t³): gradientes C²-contínuos, sem artefatos de grade
  fn noise3D(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
      mix(mix(hash31(i + vec3<f32>(0.0,0.0,0.0)), hash31(i + vec3<f32>(1.0,0.0,0.0)), u.x),
          mix(hash31(i + vec3<f32>(0.0,1.0,0.0)), hash31(i + vec3<f32>(1.0,1.0,0.0)), u.x), u.y),
      mix(mix(hash31(i + vec3<f32>(0.0,0.0,1.0)), hash31(i + vec3<f32>(1.0,0.0,1.0)), u.x),
          mix(hash31(i + vec3<f32>(0.0,1.0,1.0)), hash31(i + vec3<f32>(1.0,1.0,1.0)), u.x), u.y),
      u.z
    );
  }

  // Matriz de rotação entre oitavas do FBM (técnica do iq): elimina viés axial
  const M3 = mat3x3<f32>(
    0.00, 0.80, 0.60,
    -0.80, 0.36, -0.48,
    -0.60, -0.48, 0.64
  );

  fn fbm3(p: vec3<f32>) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var pos = p;
    for (var i = 0; i < 3; i++) {
      v += a * noise3D(pos);
      pos = (M3 * pos) * 2.02;
      a *= 0.5;
    }
    return v;
  }

  fn fbm5(p: vec3<f32>) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var pos = p;
    for (var i = 0; i < 5; i++) {
      v += a * noise3D(pos);
      pos = (M3 * pos) * 2.02;
      a *= 0.5;
    }
    return v;
  }

  // Leito do rio: sedimento fino com moitas de pedra. O fundo padrão é
  // liso e a foto de seixos só aparece em aglomerados — escala fixa por
  // amostra (escala contínua vira anéis concêntricos)
  fn riverBedTex(p: vec2<f32>) -> vec3<f32> {
    let warp = vec2<f32>(
      noise3D(vec3<f32>(p.x * 0.55, 1.3, p.y * 0.55)),
      noise3D(vec3<f32>(p.y * 0.55, 7.9, p.x * 0.55))) - 0.5;
    let q = p + warp * 1.5;
    let a = texLin(texWet, q * 0.30);
    let b = texLin(texWet, vec2<f32>(q.y, -q.x) * 0.17 + vec2<f32>(0.41, 0.73));
    let c = texLin(texWet, vec2<f32>(q.x + q.y, q.y - q.x) * 0.32 + vec2<f32>(0.13, 0.57));
    // trechos (~20 m) de pedra graúda ou miúda
    let zone = fbm3(vec3<f32>(p.x * 0.05, 11.0, p.y * 0.05));
    var st = mix(a, c, smoothstep(0.42, 0.52, zone));
    st = mix(st, b, 1.0 - smoothstep(0.30, 0.44, zone));
    // pedra só onde o rio deposita cascalho: moitas de ~10 m separadas
    // por fundo limpo — fim do tapete uniforme de pedrinhas
    let cover = smoothstep(0.50, 0.66, fbm3(vec3<f32>(p.x * 0.10, 4.2, p.y * 0.10)));
    // sedimento: luminância da mesma foto em escala bem maior (borrada)
    let sedLum = dot(texLin(texWet, q * 0.045), vec3<f32>(0.33));
    var t = mix(vec3<f32>(sedLum) * vec3<f32>(0.64, 0.60, 0.48), st, cover);
    // manchas de seixo de praia dentro dos aglomerados
    let alt = smoothstep(0.55, 0.75, fbm3(vec3<f32>(p.x * 0.09, 9.4, p.y * 0.09)));
    t = mix(t, texLin(texGround, q * 0.42), alt * 0.55 * cover);
    return t;
  }

  // --- ÁGUA CORRENTE ("Where the River Goes" / P_Malin, adaptado) ---
  fn hashF(p: f32) -> f32 {
    var p2 = fract(vec2<f32>(p, p) * vec2<f32>(4.438975, 3.972973));
    p2 += dot(p2.yx, p2.xy + 19.19);
    return fract(p2.x * p2.y);
  }

  fn hash22(p: f32) -> vec2<f32> {
    var p3 = fract(vec3<f32>(p, p, p) * vec3<f32>(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  // Value noise 2D com derivadas analíticas: retorna (dx, dy, valor)
  fn noiseDXY(o: vec2<f32>) -> vec3<f32> {
    let p = floor(o);
    let f = fract(o);
    let n = p.x + p.y * 57.0;
    let a = hashF(n);
    let b = hashF(n + 1.0);
    let c = hashF(n + 57.0);
    let d = hashF(n + 58.0);
    let f2 = f * f;
    let f3 = f2 * f;
    let t = 3.0 * f2 - 2.0 * f3;
    let dt = 6.0 * f - 6.0 * f2;
    let res = a + (b - a) * t.x + (c - a) * t.y + (a - b + d - c) * t.x * t.y;
    let dx = (b - a) * dt.x + (a - b + d - c) * dt.x * t.y;
    let dy = (c - a) * dt.y + (a - b + d - c) * t.x * dt.y;
    return vec3<f32>(dx, dy, res);
  }

  // FBM_DXY: a cada oitava o domínio avança no sentido do fluxo (com sinal
  // alternado) e é deformado pelo próprio gradiente — são essas ondulações
  // que "escalam" corrente abaixo que dão o aspecto de água viva
  fn fbmDXY(p0: vec2<f32>, flow0: vec2<f32>, ps: f32, df: f32) -> vec3<f32> {
    var f = vec3<f32>(0.0);
    var tot = 0.0;
    var a = 1.0;
    var p = p0;
    var flow = flow0;
    for (var i = 0; i < 4; i++) {
      p += flow;
      flow *= -0.75;
      let v = noiseDXY(p);
      f += v * a;
      p += v.xy * df;
      p *= 2.0;
      tot += a;
      a *= ps;
    }
    return f / tot;
  }

  // Hash inteiro idêntico ao ProceduralNoise de math.js (mesma sequência
  // de imul reproduzida em u32): a profundidade calculada aqui bate com o
  // leito real de world.js para qualquer semente (viaja em cameraPos.w)
  fn worldHash(ix: i32, iz: i32) -> f32 {
    var n = u32(ix) * 374761393u + u32(iz) * 668265263u + u32(frame.cameraPos.w) * 1442695041u;
    n = n ^ (n >> 13u);
    n = n * 1274126177u;
    n = n ^ (n >> 16u);
    return f32(n) * (1.0 / 4294967296.0);
  }

  fn worldNoise2D(x: f32, z: f32) -> f32 {
    let ix = i32(floor(x));
    let iz = i32(floor(z));
    let fx = x - f32(ix);
    let fz = z - f32(iz);
    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uz = fz * fz * (3.0 - 2.0 * fz);
    let a = worldHash(ix, iz);
    let b = worldHash(ix + 1, iz);
    let c = worldHash(ix, iz + 1);
    let d = worldHash(ix + 1, iz + 1);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  }

  // fbm(·,·,3) do ProceduralNoise: freq×2.03, amp×0.48, normalizado
  fn worldFbm3(x: f32, z: f32) -> f32 {
    var val = 0.0;
    var amp = 0.5;
    var freq = 1.0;
    var norm = 0.0;
    for (var i = 0; i < 3; i++) {
      val += amp * worldNoise2D(x * freq, z * freq);
      norm += amp;
      freq *= 2.03;
      amp *= 0.48;
    }
    return val / norm;
  }

  // Planta da ilha (costa, maciço e rede de rios) gerada do island.js
${ISLAND_WGSL}

  // Distância à costa (m, positiva terra adentro) — shoreDist do world.js:
  // contorno da planta deformado pelo mesmo fbm
  fn islandShore(x: f32, z: f32) -> f32 {
    let cdN = worldFbm3(x * 0.0035 + 6.7, z * 0.0035 - 1.9);
    let p = vec2<f32>(x, z);
    return islandCoastR(p) * (1.0 + (cdN - 0.5) * 0.09) - length(p);
  }

  // Profundidade local d'água (>0 = submerso): espelha o getTerrainHeight
  // do world.js (S=2600 — manter sincronizado) na praia, na várzea e no
  // leito dos rios (declive contínuo ao mar) e no fundo do mar (seaBed) —
  // a linha d'água e a espuma acompanham rio e praia de verdade. O chão
  // da mata, que a água nunca alcança, é aproximado pela cota da várzea
  fn waterDepthAt(x: f32, z: f32) -> f32 {
    let shore = islandShore(x, z);
    let seaBed = -6.8 + worldFbm3(x * 0.15 - 2.0, z * 0.15 + 4.0) * 1.2;
    // Alto-mar: além do mergulho costeiro (S·0.04) só existe o fundo marinho
    if (shore <= -104.0) { return -2.38 - seaBed; }

    // Restinga: a planície de praia desce de +1.5 a -0.6 até a orla
    let flood = -0.55 + (worldFbm3(x * 0.085 + 4.1, z * 0.085 - 2.8) - 0.5) * 0.9;
    let plainT = 1.0 - smoothstep(0.0, 156.0, shore);
    let plainW = 1.0 - (1.0 - plainT) * (1.0 - plainT);
    let beachH = 1.5 - 2.1 * plainT + (worldFbm3(x * 0.055 + 2.2, z * 0.055 - 4.4) - 0.5) * 1.7;
    var approxH = mix(flood, beachH, plainW);

    // Rios: várzea baixa + canal que alarga rumo à foz (= riverCore/riverMask)
    let p = vec2<f32>(x, z);
    let rd = islandRiver(p).z;
    let core = 14.0 + 6.0 * (1.0 - smoothstep(0.0, 182.0, shore));
    // dry: canal corta o sopé e some só no miolo do maciço (world.js)
    let mountM = smoothstep(0.0, 169.0, 78.0 - islandMountSdf(p));
    let dry = 1.0 - smoothstep(0.45, 0.90, mountM);
    let valley = (1.0 - smoothstep(core + 14.0, core + 64.0, rd)) * dry;
    approxH = mix(approxH, min(approxH, flood), valley);
    let chan = (1.0 - smoothstep(core, core + 8.0, rd)) * dry;
    // Declive da nascente à foz, ≥1.5 m abaixo de −2.38
    var bedY = -5.3 + 1.4 * smoothstep(0.0, 390.0, max(shore, 0.0));
    bedY += (worldFbm3(x * 0.055 + 5.5, z * 0.055 - 3.1) - 0.5) * 0.2;
    bedY += (1.0 - smoothstep(0.0, 117.0, islandMountSdf(p))) * 0.2;
    bedY = min(bedY, -3.88); // waterLevel − 1.5
    approxH = mix(approxH, bedY, chan);
    // Trava do miolo (world.js): terreno sob a água no eixo do canal
    if (rd < core * 0.9 && dry > 0.4) {
      approxH = min(approxH, -3.38); // waterLevel − 1.0
    }

    // Mar ao redor da ilha: além da orla o fundo afunda (com o mergulho
    // extra que define a linha de praia)
    let seaM = 1.0 - smoothstep(-104.0, 0.0, shore);
    approxH = mix(approxH, seaBed, seaM) - seaM * (1.0 - seaM) * 10.0;
    return -2.38 - approxH;
  }

  // Uma amostra da superfície: FBM_DXY advectado, filtragem pela derivada
  // de tela (espelha à distância, sem cintilação) e normal achatado na espuma.
  // fwidthUv chega pronto: dpdx/dpdy exigem fluxo uniforme e o branch de
  // material não é — as derivadas são tomadas sobre worldPos no topo do fsMain
  fn waterSurf(uv: vec2<f32>, flowOff: vec2<f32>, fMag: f32, foam: f32, fwidthUv: f32, freq: f32) -> vec4<f32> {
    var fScale = 1.0 / (1.0 + fwidthUv * fwidthUv * 2000.0);
    let dxy = fbmDXY(uv * freq, flowOff * freq, 0.75 + foam * 0.25, 0.25 - foam * 1.5);
    fScale *= max(0.25, 1.0 - foam * 5.0);
    let blended = mix(vec3<f32>(0.0, 1.0, 0.0), normalize(vec3<f32>(dxy.x, fMag, dxy.y)), fScale);
    return vec4<f32>(normalize(blended), dxy.z * fScale);
  }

  // Filamentos de espuma: mesma família FBM_DXY em frequência maior,
  // advectada mais devagar — laços que descem o rio com a corrente
  fn waterFoamTex(uv: vec2<f32>, flowOff: vec2<f32>) -> f32 {
    var f = fbmDXY(uv * 9.0, flowOff * 15.0, 0.8, -0.5).z;
    f = max(0.0, (f - 0.2) / 0.2);
    return pow(0.5, f);
  }

  // Arrebentação (GetShorelineWaves do Castaway, wt3XDj — P_Malin):
  // ondas rasas correndo para a praia. Retorna (altura do swash ~m,
  // espuma logo atrás da crista). A fase avança com a profundidade → a
  // crista viaja mar → areia; a amplitude morre com exp(-d·0.7) e é
  // modulada por ruído ao longo da costa — ondas chegam em grupos
  fn shoreWaves(pos: vec2<f32>, dh: f32, t: f32) -> vec2<f32> {
    let d = max(dh, 0.0);
    var p = d * 8.0 + t * 1.5;
    let nz = vec2<f32>(
      worldNoise2D(pos.x * 0.1, pos.y * 0.1),
      worldNoise2D(pos.x * 0.1 + 13.7, pos.y * 0.1 - 7.1)
    );
    p += nz.x * 4.0;
    let waveMag = exp(-d * 0.7);
    let sw = sin(p + cos(p) * (1.0 - waveMag)) * -0.5 + 0.5;
    let fm = sin(p - 2.67) * 0.5 + 0.5;
    return vec2<f32>(sw * sqrt(waveMag), fm * waveMag) * nz.y;
  }

  // --- CAMADA DE NUVENS PROCEDURAIS (plano a 240m, FBM rotacionado advectado pelo vento) ---
  fn cloudDensity(uv: vec2<f32>) -> f32 {
    var v = 0.0;
    var a = 0.55;
    var p3 = vec3<f32>(uv, 7.31);
    for (var i = 0; i < 4; i++) {
      v += a * noise3D(p3);
      p3 = (M3 * p3) * 2.02;
      a *= 0.52;
    }
    return v;
  }

  // Campo combinado base + detalhe (bordas irregulares)
  fn cloudField(cuv: vec2<f32>) -> f32 {
    return cloudDensity(cuv) * 0.72 + cloudDensity(cuv * 2.6 + vec2<f32>(31.7, 11.3)) * 0.28;
  }

  fn cloudCoverage(cuv: vec2<f32>) -> f32 {
    return smoothstep(0.56, 0.74, cloudField(cuv));
  }

  fn cloudUV(worldPos: vec3<f32>) -> vec2<f32> {
    return worldPos.xz * 0.011 + vec2<f32>(frame.params.x * 0.014, frame.params.x * 0.008);
  }

  // --- VENTO ORGÂNICO MULTI-FREQUÊNCIA ---
  fn applyWind(pos: vec3<f32>, worldBase: vec3<f32>, phase: f32, weight: f32, uvY: f32) -> vec3<f32> {
    let strength = frame.params.y * weight;
    if (strength <= 0.001) { return pos; }
    let t = frame.params.x * 1.75;
    let gust = sin(t + phase + worldBase.x * 0.13 + worldBase.z * 0.10)
             + 0.48 * cos(t * 2.15 + phase * 1.6 + pos.y * 1.25);
    let flutter = sin(t * 5.2 + pos.x * 4.5 + pos.z * 4.5) * 0.09;
    let factor = (clamp(uvY, 0.0, 1.0) * 0.85 + 0.15) * strength * 0.23;
    return pos + vec3<f32>((gust + flutter) * factor, -abs(gust) * factor * 0.14, (gust * 0.82 - flutter) * factor);
  }

  // --- SHADOW PASS VERTEX SHADERS ---
  @vertex
  fn vsShadowTerrain(in: VertexInput) -> @builtin(position) vec4<f32> {
    return frame.lightViewProj * vec4<f32>(in.position, 1.0);
  }

  // Silhueta de folha lanceolada com margem serrilhada (alpha test)
  fn leafSilhouette(uv: vec2<f32>) -> f32 {
    let p = uv - vec2<f32>(0.5, 0.5);
    return 0.42 * cos(p.y * 3.14159) - 0.02 + sin(p.y * 55.0) * 0.015 - abs(p.x);
  }

  // Silhueta de folha arredondada/oval (espécie B)
  fn leafSilhouetteRound(uv: vec2<f32>) -> f32 {
    let p = uv - vec2<f32>(0.5, 0.5);
    return 0.40 * sqrt(max(0.0, 1.0 - p.y * p.y * 4.0)) - 0.015 - abs(p.x);
  }

  struct ShadowOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) matId: f32,
  };

  @vertex
  fn vsShadowInstanced(in: VertexInput, inst: InstanceInput) -> ShadowOut {
    var out: ShadowOut;
    let c = cos(inst.instMeta.x);
    let s = sin(inst.instMeta.x);
    var localPos = vec3<f32>(
      in.position.x * c - in.position.z * s,
      in.position.y,
      in.position.x * s + in.position.z * c
    ) * inst.instPosScale.w;
    localPos = applyWind(localPos, inst.instPosScale.xyz, inst.instMeta.y, inst.instMeta.w, in.uv.y);
    out.clipPos = frame.lightViewProj * vec4<f32>(localPos + inst.instPosScale.xyz, 1.0);
    out.uv = in.uv;
    out.matId = in.matId;
    return out;
  }

  // Recorte da silhueta da folha também no mapa de sombras
  @fragment
  fn fsShadowClip(in: ShadowOut) {
    let mat = i32(in.matId + 0.5);
    if ((mat == 2 && leafSilhouette(in.uv) < 0.0) ||
        ((mat == 7 || mat == 10) && leafSilhouetteRound(in.uv) < 0.0)) {
      discard;
    }
  }

  // --- MAIN PASS VERTEX SHADERS ---
  @vertex
  fn vsTerrain(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.worldPos = in.position;
    out.worldNormal = in.normal;
    out.color = in.color;
    out.uv = in.uv;
    out.matId = in.matId;
    out.hueJit = 0.0;
    out.clipPos = frame.viewProj * vec4<f32>(in.position, 1.0);
    return out;
  }

  @vertex
  fn vsInstanced(in: VertexInput, inst: InstanceInput) -> VertexOutput {
    var out: VertexOutput;
    let c = cos(inst.instMeta.x);
    let s = sin(inst.instMeta.x);
    var scale = inst.instPosScale.w;
    // Sub-bosque (samambaia/grama, mat 3) só é desenhado perto da câmera:
    // encolhe até sumir no limite do alcance (sunDir.w) em vez de pipocar
    // célula a célula
    if (in.matId > 2.5 && in.matId < 3.5 && frame.sunDir.w > 0.0) {
      let camDist = distance(inst.instPosScale.xyz, frame.cameraPos.xyz);
      scale *= 1.0 - smoothstep(frame.sunDir.w * 0.7, frame.sunDir.w, camDist);
    }

    var localPos = vec3<f32>(
      in.position.x * c - in.position.z * s,
      in.position.y,
      in.position.x * s + in.position.z * c
    ) * scale;

    localPos = applyWind(localPos, inst.instPosScale.xyz, inst.instMeta.y, inst.instMeta.w, in.uv.y);

    let worldPos = localPos + inst.instPosScale.xyz;
    let worldNorm = normalize(vec3<f32>(
      in.normal.x * c - in.normal.z * s,
      in.normal.y,
      in.normal.x * s + in.normal.z * c
    ));

    out.worldPos = worldPos;
    out.worldNormal = worldNorm;
    out.color = in.color * abs(inst.instMeta.z);
    out.uv = in.uv;
    out.matId = in.matId;
    // Variação determinística de matiz por instância (copas da mesma árvore variam sutilmente)
    out.hueJit = fract(sin(dot(inst.instPosScale.xz, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    // Tint negativo marca rocha dentro do rio: o sinal viaja em hueJit
    // (campo que a rocha não usa) e o fsMain lê como flag
    if (inst.instMeta.z < 0.0) { out.hueJit = -1.0; }
    out.clipPos = frame.viewProj * vec4<f32>(worldPos, 1.0);
    return out;
  }

  // --- SHADOW SAMPLING PCF 3x3 ---
  fn sampleShadowPCF(worldPos: vec3<f32>, N: vec3<f32>, L: vec3<f32>) -> f32 {
    let lightClip = frame.lightViewProj * vec4<f32>(worldPos, 1.0);
    let projCoords = lightClip.xyz / lightClip.w;
    let uv = vec2<f32>(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);

    if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998 || projCoords.z < 0.0 || projCoords.z > 1.0) {
      return 1.0;
    }

    let slopeBias = max(frame.params2.z * (1.0 - dot(N, L)), frame.params2.z * 0.25);
    let depthRef = projCoords.z - slopeBias;
    let texelSize = vec2<f32>(1.0 / f32(textureDimensions(shadowMap).x));

    var shadow = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
        shadow += textureSampleCompareLevel(shadowMap, shadowSampler, uv + offset, depthRef);
      }
    }
    return shadow / 9.0;
  }

  // --- FUNÇÕES PBR COOK-TORRANCE GGX ---
  fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / max(3.14159265 * denom * denom, 0.0001);
  }

  fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
  }

  fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
  }

  fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  }

  // --- MAIN FRAGMENT SHADER PBR ---
  @fragment
  fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
    var N = normalize(in.worldNormal);
    let V = normalize(frame.cameraPos.xyz - in.worldPos);
    let L = normalize(frame.sunDir.xyz);
    let H = normalize(L + V);

    var albedo = in.color;
    var roughness = 0.85;
    var metallic = 0.0;
    var ao = 1.0;
    var emissive = vec3<f32>(0.0);

    // Estado do rio (mat 6): preenchido no branch de material e consumido
    // na composição de ambiente, quando a sombra PCF já existe
    var wDepth = 0.0;
    var wFoam = 0.0;
    var wFoamBlend = 0.0;
    var wH = 0.5;
    var wSea = 0.0;
    var wSwash = 0.0;

    let mat = i32(in.matId + 0.5);
    let distToCam = length(in.worldPos - frame.cameraPos.xyz);
    // Fade do detalhe fino com a distância: evita cintilação (shimmer)
    let detailFade = 1.0 / (1.0 + distToCam * 0.04);
    // Derivadas de tela do worldPos em fluxo uniforme (área de pixel no
    // domínio da água — o branch de material não pode chamar dpdx/dpdy)
    let wpDx = dpdx(in.worldPos.xz);
    let wpDy = dpdy(in.worldPos.xz);
    let waterFwidth = max(max(abs(wpDx.x), abs(wpDx.y)), max(abs(wpDy.x), abs(wpDy.y)));

    // Recorte da silhueta da folha na copa, com borda erodida por ruído real
    // (silhueta irregular orgânica em vez de curva matemática limpa).
    // edgeN só é amostrado para materiais de folha — fora deles seria um
    // fetch desperdiçado em todo fragmento de terreno/rocha/casca.
    if (mat == 2 || mat == 7 || mat == 10) {
      let edgeN = textureSampleLevel(texNoise, texSamp, in.uv * 3.0 + vec2<f32>(in.hueJit * 37.0, in.hueJit * 11.0), 0.0).r;
      if ((mat == 2 && leafSilhouette(in.uv) < (edgeN - 0.5) * 0.11) ||
          ((mat == 7 || mat == 10) && leafSilhouetteRound(in.uv) < (edgeN - 0.5) * 0.11)) {
        discard;
      }
    }

    // Perturbação de Normal Procedural por Material (World-Space Bump)
    // dpdx/dpdy exigem fluxo uniforme: acumulamos bump/escala nos branches
    // e aplicamos as derivadas uma única vez após o if-chain.
    var bump = 0.0;
    var bumpScale = 0.0;
    if (mat == 0) {
      // Terreno: musgo, serrapilheira e terra em múltiplas escalas de detalhe
      let wp = in.worldPos;
      let micro = fbm5(wp * 3.8);
      let grain = noise3D(wp * 22.0);
      let fibers = noise3D(wp * 41.0);
      let fineFade = 0.55 + 0.45 * detailFade;
      // Textura fotográfica de solo pedregoso: luminância modula o albedo (mantém a paleta)
      let soil = textureSampleLevel(texGround, texSamp, wp.xz * 0.65, 0.0).r;
      let soilMacro = textureSampleLevel(texGround, texSamp, wp.xz * 0.13, 0.0).r;
      albedo *= (0.74 + 0.52 * micro)
              * (1.0 + fineFade * (0.30 * grain - 0.15))
              * (1.0 + fineFade * (0.24 * fibers - 0.12))
              * (1.0 + detailFade * (0.55 * soil - 0.28))
              * (0.85 + 0.30 * soilMacro);
      // Musgo é áspero; manchas de terra úmida/folhas molhadas refletem levemente
      roughness = mix(0.94, 0.50, smoothstep(0.55, 0.85, grain) * smoothstep(0.40, 0.75, micro));
      ao = 0.70 + 0.30 * micro * (0.8 + 0.4 * grain);
      bump = (micro * 0.55 + grain * 0.30 + fibers * 0.15 + soil * 0.45) * 0.24;
      bumpScale = 3.2;

      // Estratos rochosos per-pixel em encostas (complementa a zona rochosa por vértice)
      let slope = 1.0 - clamp(in.worldNormal.y, 0.0, 1.0);
      let rockAmt = smoothstep(0.28, 0.55, slope);
      if (rockAmt > 0.0) {
        // Grão de rocha por ruído esticado 40x em y (fdlyW4: textura de ruído
        // em vec2(pos.x, pos.y*48)) — decorrelaciona linha a linha. A foto de
        // rocha projetada em v=altitude repetia as bandas da imagem a cada
        // ~5m e lia como artefato de impressão
        let grainY = texLin(texGray, vec2<f32>(wp.x * 0.6 + wp.z * 0.4, wp.y * 40.0) * 0.025).r;
        let rockGrain = noise3D(wp * 26.0);
        let strata = fbm3(wp * vec3<f32>(0.10, 0.35, 0.10) + vec3<f32>(7.7));
        albedo *= mix(vec3<f32>(1.0), vec3<f32>(0.78 + 0.50 * grainY) * (0.80 + 0.42 * strata), rockAmt * 0.9);
        albedo *= 1.0 + (rockGrain - 0.5) * 0.55 * rockAmt;
        roughness = mix(roughness, 0.88, rockAmt);
        bump += (grainY * 0.5 + rockGrain * 0.25 + strata * 0.15) * rockAmt;
      }

      // Máscaras de cobertura vindas do world.js no uv do terreno:
      // x = areia de praia, y = campo aberto entre os capões de mata
      let sand = clamp(in.uv.x, 0.0, 1.0);
      let meadow = clamp(in.uv.y, 0.0, 1.0);

      // Areia com grão de verdade: a textura dá a estrutura do grão e a
      // cor do vértice mantém o tom (seca clara → molhada dourada →
      // baixio escuro). st/0.416 ≈ 1 na média — o grão atravessa sem
      // deslocar a paleta
      if (sand > 0.0) {
        let st = texLin(texSand, wp.xz * 0.5);
        let stLum = dot(st, vec3<f32>(0.33));
        albedo *= mix(vec3<f32>(1.0), st / 0.416, sand * 0.85);
        bump += stLum * 0.6 * sand;
      }

      // Chão do vale: serrapilheira + galharia fotográficas (só em baixa altitude
      // e encosta suave — não nas encostas rochosas do maciço, nem na areia
      // da praia; rala no campo, onde o capim cobre o solo)
      let valleyAmt = (1.0 - rockAmt) * (1.0 - smoothstep(7.0, 17.0, wp.y))
                    * (1.0 - sand) * (1.0 - 0.75 * meadow);
      if (valleyAmt > 0.0) {
        let litT = texLin(texLitter, wp.xz * 0.115);
        let litLum = dot(litT, vec3<f32>(0.299, 0.587, 0.114));
        let twg = texLin(texTwigs, wp.xz * 0.31 + vec2<f32>(0.4, 0.7));
        let twgLum = dot(twg, vec3<f32>(0.33));
        albedo = mix(albedo, litT * (0.62 + 0.55 * soilMacro), valleyAmt * 0.50);
        albedo = mix(albedo, twg * (0.45 + 0.45 * micro), valleyAmt * smoothstep(0.52, 0.78, grain) * 0.35);
        bump += (litLum * 0.30 + twgLum * 0.40) * valleyAmt;
      }

      // Leito do rio: seixos molhados fotográficos + superfície úmida.
      // Na praia não há seixos: a faixa junto à linha d'água é areia
      // molhada — mais escura e lisa que a areia seca
      let wetLine = 1.0 - smoothstep(-2.0, -0.9, wp.y);
      let wet = wetLine * (1.0 - sand);
      if (wet > 0.0) {
        let ws = riverBedTex(wp.xz);
        let wsLum = dot(ws, vec3<f32>(0.33));
        albedo = mix(albedo, ws * 0.80, wet * 0.75);
        roughness = mix(roughness, 0.28, wet * 0.8);
        bump += wsLum * 0.45 * wet;
      }
      // Areia molhada (Castaway): mais escura e quase espelhada. A borda
      // superior da faixa úmida acompanha o alcance recente da
      // arrebentação — mesma shoreWaves que move a linha d'água, então
      // a areia que a onda acabou de lamber continua úmida e brilhante
      var wetSand = wetLine * sand;
      if (sand > 0.001 && wp.y < -0.8) {
        let tW = frame.params.x;
        let reach = -2.38 + 0.25 + 0.9 * max(max(
          shoreWaves(wp.xz, 0.0, tW - 0.05).x,
          shoreWaves(wp.xz, 0.0, tW - 0.85).x),
          shoreWaves(wp.xz, 0.0, tW - 1.7).x);
        wetSand = max(wetSand, (1.0 - smoothstep(reach - 0.45, reach, wp.y)) * sand);
      }
      albedo *= 1.0 - 0.50 * wetSand;
      roughness = mix(roughness, 0.12, wetSand * 0.9);
    } else if (mat == 1 || mat == 8) {
      // Casca: fissuras verticais profundas, placas rachadas e líquen
      let wp = in.worldPos;
      let barkNoise = fbm5(vec3<f32>(wp.x * 6.0, wp.y * 1.4, wp.z * 6.0));
      let cords = noise3D(vec3<f32>(wp.x * 26.0, wp.y * 2.2, wp.z * 26.0));
      let ridges = abs(cords * 2.0 - 1.0);
      let groove = pow(1.0 - ridges, 3.0); // fundo escuro das fissuras
      let plates = noise3D(vec3<f32>(wp.x * 9.0, wp.y * 7.0, wp.z * 9.0));
      let lichen = smoothstep(0.58, 0.82, fbm3(wp * 2.4) + max(0.0, N.z) * 0.25);
      // Textura fotográfica de casca: mat 1 = copaíba c/ musgo, mat 8 = casca rachada
      let btUV = vec2<f32>(in.uv.x * 2.0, in.uv.y * 0.16);
      let bt = select(texLin(texBark, btUV), texLin(texBark2, btUV), mat == 8);
      let bLum = dot(bt, vec3<f32>(0.299, 0.587, 0.114));
      albedo = mix(
        mix(albedo * (0.62 + 0.62 * barkNoise) * (0.72 + 0.28 * plates) * (1.0 - groove * 0.5), bt * (0.55 + 0.75 * barkNoise), 0.85),
        vec3<f32>(0.16, 0.27, 0.14), lichen * 0.55);
      roughness = 0.94;
      ao = (0.62 + 0.38 * barkNoise) * (1.0 - groove * 0.30) * (0.75 + 0.5 * bLum);
      bump = barkNoise * 0.18 + (1.0 - ridges) * 0.34 + bLum * 0.3;
      bumpScale = 4.0;
    } else if (mat == 2 || mat == 3 || mat == 7 || mat == 10) {
      // Copas, Samambaias e Grama: estrutura interna da folha em espaço UV
      // (o detalhe por worldPos é constante dentro de uma folha — a textura real é por UV)
      let leafVar = noise3D(in.worldPos * 2.2);
      let isLeaf = mat != 3;
      let leafSeed = in.hueJit * 61.7 + 3.3;

      // Aréolas: textura de ruído real do Shadertoy (canais independentes = 2 escalas)
      let cells = textureSampleLevel(texNoise, texSamp, in.uv * vec2<f32>(5.0, 7.0) + vec2<f32>(leafSeed), 0.0).g;
      let cells2 = textureSampleLevel(texNoise, texSamp, in.uv * vec2<f32>(11.0, 15.0) + vec2<f32>(leafSeed * 1.7), 0.0).b;

      // Nervura central + nervuras laterais em chevron (mais claras: tecido translúcido)
      let midrib = (1.0 - smoothstep(0.0, 0.05, abs(in.uv.x - 0.5))) * select(0.0, 1.0, isLeaf);
      let latV = abs(fract(in.uv.y * 11.0 - abs(in.uv.x - 0.5) * 7.0) - 0.5) * 2.0;
      let veins = midrib + (1.0 - smoothstep(0.0, 0.10, latV)) * 0.5 * (1.0 - midrib);

      // Bordas mais escuras simulam a curvatura natural da folha (falso volumétrico)
      let curl = 1.0 - smoothstep(0.0, 0.5, abs(in.uv.x - 0.5)) * 0.32;
      // Gradiente pecíolo -> ápice
      let along = 0.92 + 0.08 * in.uv.y;

      albedo = albedo * (0.80 + 0.30 * leafVar)
             * (0.86 + 0.26 * cells) * (0.90 + 0.20 * cells2)
             * curl * along;
      // Nervuras sobem ligeiramente de tom
      albedo += select(vec3<f32>(0.030, 0.048, 0.008), vec3<f32>(0.060, 0.014, 0.010), mat == 10) * veins;

      // Mosqueado de matiz entre folhas: tons amarelados/escuros naturais
      // (ruído procedural + gray noise texturizado, quebra a periodicidade)
      let gN = texLin(texGray, in.worldPos.xz * 0.85 + vec2<f32>(leafSeed * 0.13, leafSeed * 0.29)).x;
      let mottle = mix(noise3D(in.worldPos * 1.15 + vec3<f32>(4.7, 0.0, 2.3)), gN, 0.45);
      albedo *= vec3<f32>(0.88 + 0.34 * mottle, 1.0, 0.82 + 0.22 * mottle);
      // Variação de matiz por instância: algumas copas puxam para o dourado/oliva
      albedo = mix(albedo, albedo * vec3<f32>(1.30, 1.02, 0.58), in.hueJit * 0.42);

      // Ápice ressecado/marrom em algumas folhas — variação natural
      if (isLeaf) {
        let dryN = noise3D(vec3<f32>(in.uv * 3.0, in.hueJit * 97.0 + 11.1));
        let dry = smoothstep(0.62, 0.85, dryN) * smoothstep(0.55, 0.95, in.uv.y);
        albedo = mix(albedo, vec3<f32>(0.30, 0.23, 0.09), dry * 0.6);
      }

      if (mat == 7) {
        albedo *= vec3<f32>(1.10, 0.98, 0.72); // espécie de folha arredondada: tom oliva
      }
      roughness = 0.48; // Cutícula cerosa das folhas
      ao = 0.65 + 0.35 * in.uv.y;
      bump = leafVar * 0.06 + veins * 0.08 + cells * 0.05 + cells2 * 0.02;
      bumpScale = 1.8;
    } else if (mat == 4) {
      // Rocha: grão mineral com brilhos, estratos e musgo nas faces superiores
      let wp = in.worldPos;
      let rockGrain = fbm3(wp * 9.0);
      let fleck = noise3D(wp * 55.0);
      let strata = 0.5 + 0.5 * sin(wp.y * 3.2 + fbm3(wp * vec3<f32>(0.8, 0.3, 0.8)) * 6.0);
      // Textura de rocha real com projeção triplanar simplificada (eixo dominante)
      let an = abs(in.worldNormal);
      var ruv = wp.xz * 0.40;
      if (an.x >= an.y && an.x >= an.z) { ruv = wp.zy * 0.40; }
      else if (an.z >= an.y) { ruv = wp.xy * 0.40; }
      // Mistura de duas rochas fotográficas (cinza + granito) por máscara de ruído
      let gmix = smoothstep(0.40, 0.68, fbm3(wp * 0.13 + vec3<f32>(5.5, 0.0, 2.2)));
      let rt = mix(texLin(texRock, ruv), texLin(texGranite, ruv * 0.7), gmix);
      let rLum = dot(rt, vec3<f32>(0.299, 0.587, 0.114));
      albedo = mix(albedo * (0.66 + 0.22 * strata + 0.30 * rockGrain) * (0.86 + 0.28 * fleck), rt, 0.72);
      // Rocha de rio (hueJit < 0): cinza dessaturado e ligeiramente mais
      // escuro/liso — pedra lavada pela água, sem musgo
      let riverRock = in.hueJit < -0.5;
      if (riverRock) {
        let rl = dot(albedo, vec3<f32>(0.299, 0.587, 0.114));
        albedo = vec3<f32>(rl * 0.78, rl * 0.80, rl * 0.84);
      }
      let mossAmt = smoothstep(0.45, 0.85, max(0.0, in.worldNormal.y) * (0.55 + 0.9 * fbm3(wp * 1.8))) * select(1.0, 0.0, riverRock);
      albedo = mix(albedo, vec3<f32>(0.09, 0.18, 0.06), mossAmt * 0.65);
      roughness = mix(select(0.72, 0.40, riverRock), 0.95, max(max(0.0, N.y), mossAmt));
      bump = (rockGrain * 0.45 + strata * 0.35 + fleck * 0.20 + rLum * 0.5) * 0.3;
      bumpScale = 3.5;
    } else if (mat == 9) {
      // Tronco caído: madeira fotográfica com grão longitudinal
      let wp = in.worldPos;
      let wd = texLin(texWood, vec2<f32>(in.uv.x * 1.6, in.uv.y * 0.6));
      let wLum = dot(wd, vec3<f32>(0.299, 0.587, 0.114));
      let weather = fbm3(wp * 3.5);
      albedo = wd * (0.50 + 0.65 * weather);
      roughness = 0.82;
      ao = 0.72 + 0.45 * wLum;
      bump = wLum * 0.5 + weather * 0.15;
      bumpScale = 2.6;
    } else if (mat == 5) {
      // Cogumelo Bioluminescente
      let isNight = clamp(1.0 - frame.params.w * 2.0, 0.15, 1.0);
      let pulse = 0.8 + 0.2 * sin(frame.params.x * 2.5 + in.worldPos.x * 3.0);
      emissive = vec3<f32>(0.22, 0.95, 0.72) * (1.8 * isNight * pulse) * smoothstep(0.35, 0.8, in.uv.y);
      roughness = 0.32;
    } else if (mat == 6) {
      // Rio corrente — "Where the River Goes" (P_Malin) adaptado:
      // 1) campo de fluxo = tangente do canal + repulsão do raso
      // 2) normal = FBM com derivadas advectado em 2 fases defasadas
      //    (cross-fade no meio do ciclo → corrente contínua, sem pulsação)
      // 3) espuma por rasura/vazão; fundo refratado na etapa de ambiente.
      // A rede de rios é a da planta da ilha (island.js): cada trecho corre
      // da nascente no maciço para a foz.
      let t = frame.params.x;
      let wp = in.worldPos;
      // Alto-mar em volta da ilha: a ondulação empurra para a costa com
      // deriva lateral — não segue mais a tangente do rio
      let shoreW = islandShore(wp.x, wp.z);
      let seaM = 1.0 - smoothstep(-104.0, 105.0, shoreW);
      var flowDir = vec2<f32>(0.0, 1.0);
      // Peso da correnteza sobre a ondulação do mar: dentro do canal o rio
      // manda até a foz; mar adentro vira uma pluma que abre e se dissolve
      var rivW = 0.0;
      if (seaM < 1.0) {
        let riv = islandRiver(wp.xz); // corrente desce o rio mais próximo
        flowDir = riv.xy;
        let core = 14.0 + 6.0 * (1.0 - smoothstep(0.0, 182.0, shoreW));
        // Pluma da foz: o rio manda até bem mar adentro, sem a ondulação
        // do mar inverter a correnteza na boca
        let plume = smoothstep(-160.0, -8.0, shoreW);
        rivW = (1.0 - smoothstep(core + 4.0, core + 28.0 + (1.0 - plume) * 55.0, riv.z)) * plume;
      }

      // Profundidade (exata no canal: mesmo hash/fbm do world.js) e seu
      // gradiente — a corrente desvia dos baixios como no shader original
      let depthRaw = waterDepthAt(wp.x, wp.z);
      let depth = max(depthRaw, 0.0);
      let gEps = 0.5;
      let wGrad = vec2<f32>(
        waterDepthAt(wp.x + gEps, wp.z) - depthRaw,
        waterDepthAt(wp.x, wp.z + gEps) - depthRaw
      ) / gEps;

      // Campo de fluxo (GetFlowRate): base rio abaixo, acelera e desvia no
      // raso, desacelera em poças profundas e a jusante dos baixios.
      // flow é a velocidade aparente da água: sempre da nascente para o
      // mar (flowDir já aponta à foz); wGrad só desvia, nunca inverte
      var flow = flowDir;
      let along = max(dot(wGrad, flowDir), 0.0);
      flow += flowDir * (0.35 + along * 1.1) / (1.0 + depth * 1.5);
      flow += (wGrad - flowDir * dot(wGrad, flowDir)) * 0.45 / (1.0 + depth * 1.5);
      flow *= 1.0 / (1.0 + depth * 0.4);
      let gN = wGrad / max(length(wGrad), 0.001);
      let behind = 0.5 - dot(gN, flow / max(length(flow), 0.001)) * 0.5;
      var slow = clamp(depth * 2.2, 0.0, 1.0);
      slow = mix(slow * 0.9 + 0.1, 1.0, behind * 0.9);
      flow *= 0.5 + slow * 0.5;
      flow *= 0.15 + 0.85 * smoothstep(0.0, 0.5, depth); // poças fora do canal: quase paradas
      // Trava: no canal a componente contra a foz é descartada
      if (rivW > 0.15) {
        let back = min(dot(flow, flowDir), 0.0);
        flow -= flowDir * back;
        if (dot(flow, flowDir) < 0.05) { flow = flowDir * 0.12; }
      }

      wSea = seaM;
      let toShore = normalize(vec2<f32>(0.001) - wp.xz);
      let seaFlow = toShore * 0.75 + vec2<f32>(-toShore.y, toShore.x) * 0.30;
      flow = mix(flow, seaFlow, seaM * (1.0 - rivW));
      let flowSpeed = min(length(flow), 1.15); // evita espuma branca cobrindo o rio

      // Espuma de rasura e vazão (mesma forma funcional do original):
      // corredeiras rasas embranquecem, poças profundas ficam escuras
      var foamAcc = flowSpeed * 0.5;
      foamAcc += clamp(foamAcc - 0.4, 0.0, 1.0);
      var foam = 1.0 - pow(clamp(depth * 0.6, 0.0, 1.0), max(foamAcc * 0.35, 0.001));
      foam = clamp((foam - 0.20) * 1.5, 0.0, 1.0);
      foam = foam * foam * 0.5;
      foam *= smoothstep(0.02, 0.30, depth);
      foam += smoothstep(0.85, 1.30, flowSpeed) * 0.20; // cristas nos trechos rápidos
      wFoam = clamp(foam, 0.0, 1.0);

      // Duas fases defasadas de meio ciclo com domínios ressaltados:
      // a água nasce rio acima, corre e dissolve — advecção contínua
      let wTime = t * 0.85;
      let t0 = fract(wTime);
      let t1 = fract(wTime + 0.5);
      let uv0 = wp.xz + hash22(floor(wTime)) * 13.0;
      let uv1 = wp.xz + hash22(floor(wTime + 0.5)) * 13.0;
      let fMag = 2.5 / (1.0 + flowSpeed * flowSpeed * 5.0);
      // O ruído é amostrado em uv + offset: para o padrão andar com flow
      // o offset tem de recuar (-flow·t) — com o sinal trocado o rio subia
      let adv0 = -flow * (t0 - 0.5);
      let adv1 = -flow * (t1 - 0.5);
      let phase = abs(t0 - 0.5) * 2.0;
      // No mar a ondulação é mais baixa em frequência e mais inclinada
      // (swell). Rio e mar são duas camadas de frequência FIXA misturadas na
      // faixa costeira: uma frequência que varia no espaço multiplicaria a
      // coordenada de mundo e espelharia a correnteza justamente na foz
      var surf = vec4<f32>(0.0, 1.0, 0.0, 0.5);
      if (seaM < 0.999) {
        surf = mix(
          waterSurf(uv0, adv0, fMag, wFoam, waterFwidth, 4.0),
          waterSurf(uv1, adv1, fMag, wFoam, waterFwidth, 4.0),
          phase
        );
      }
      if (seaM > 0.001) {
        let swell = mix(
          waterSurf(uv0, adv0, fMag * 0.42, wFoam, waterFwidth, 2.0),
          waterSurf(uv1, adv1, fMag * 0.42, wFoam, waterFwidth, 2.0),
          phase
        );
        surf = mix(surf, swell, seaM);
      }
      N = normalize(surf.xyz);
      wH = surf.w;
      wFoam = clamp(wFoam + smoothstep(0.62, 0.95, wH) * 0.5 * seaM, 0.0, 1.0); // whitecaps

      // Arrebentação de praia: a crista corre para a areia (só na orla
      // do mar — rio não tem onda de praia) e espuma atrás de si
      var swashH = 0.0;
      if (depthRaw < 3.5 && seaM > 0.25) {
        let sw = shoreWaves(wp.xz, depthRaw, t);
        swashH = sw.x * 0.9;
        wFoam = clamp(wFoam + sw.y * 0.55, 0.0, 1.0);
      }
      let wFoamTex = mix(
        waterFoamTex(uv0, adv0 * 0.25),
        waterFoamTex(uv1, adv1 * 0.25),
        phase
      );
      wFoamBlend = clamp(1.0 - pow(wFoamTex, wFoam * 5.0 + 0.001), 0.0, 1.0);
      wDepth = depthRaw;
      wSwash = swashH;

      // Linha d'água viva: swell + swash decidem se o pixel é água — a
      // lâmina avança e recua sobre a areia em vez de uma reta estática
      if (depthRaw + (wH - 0.5) * 0.10 + swashH < -0.015) { discard; }

      albedo = vec3<f32>(0.0); // difuso vem da refração/espuma na etapa de ambiente
      roughness = mix(0.05, 0.5, wFoamBlend);
      ao = 1.0;
    }

    N = normalize(N + (dpdx(bump) + dpdy(bump)) * bumpScale * detailFade);

    // Sombra Real Direcional PCF 3x3 — pulada em pixels de costas para o
    // sol de materiais opacos: lá a sombra só multiplicaria termos já
    // zerados por NdotL (folha/água seguem: translucidez e reflexo a usam)
    var shadow = 1.0;
    if (dot(N, L) > 0.0 || mat == 2 || mat == 3 || mat == 6 || mat == 7 || mat == 10) {
      shadow = sampleShadowPCF(in.worldPos, N, L);
      // Sombras projetadas das nuvens: interseção do raio sol->fragmento com o plano a 240m
      // (params.w ~0 à noite anularia o fator — poupa o ruído das nuvens)
      if (L.y > 0.06 && frame.params.w > 0.02) {
        let cloudHit = in.worldPos + L * ((240.0 - in.worldPos.y) / L.y);
        let cShadow = 1.0 - cloudCoverage(cloudUV(cloudHit)) * 0.62 * clamp(frame.params.w * 2.0, 0.0, 1.0);
        shadow *= cShadow;
      }
    }

    // Cálculo Cook-Torrance GGX
    let NdotV = max(dot(N, V), 0.001);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);

    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let D = distributionGGX(NdotH, roughness);
    let G = geometrySmith(NdotV, NdotL, roughness);
    let F = fresnelSchlick(HdotV, F0);

    let numerator = D * G * F;
    let denominator = 4.0 * NdotV * NdotL + 0.0001;
    let specular = numerator / denominator;

    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);

    // Iluminação Direta do Sol
    let radiance = frame.sunColor.xyz * 2.2;
    var Lo = (kD * albedo / 3.14159265 + specular) * radiance * NdotL * shadow;

    // Subsurface Scattering (Translucidez nas folhas quando iluminadas por trás)
    if (mat == 2 || mat == 3 || mat == 7 || mat == 10) {
      let backScatter = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * (0.4 + 0.6 * in.uv.y);
      let sss = select(vec3<f32>(0.36, 0.72, 0.16), vec3<f32>(0.95, 0.20, 0.10), mat == 10) * frame.sunColor.xyz * backScatter * (0.35 + 0.65 * shadow) * 1.1;
      Lo += sss;
    }

    // Iluminação Ambiente Hemisférica + Reflexo Celeste na Água
    let hemi = N.y * 0.5 + 0.5;
    let skyAmbient = mix(vec3<f32>(0.04, 0.08, 0.06), frame.skyTopColor.xyz * 0.55 + vec3<f32>(0.05, 0.13, 0.08), hemi);
    var ambient = skyAmbient * albedo * ao;

    if (mat == 6) {
      // --- Água corrente: refração analítica + reflexo de céu/nuvens ---
      // Lâmina local ondulada pela crista (linha d'água e espuma respiram)
      let depthW = max(wDepth + (wH - 0.5) * 0.10 + wSwash, 0.0);
      let refrDir = refract(-V, N, 1.0 / 1.3333);
      let pathT = depthW / max(-refrDir.y, 0.30);
      let bedPos = in.worldPos + refrDir * pathT;

      // Leito refratado: seixos molhados sob o rio (texWet), areia da
      // restinga sob o mar (texSand) — wSea separa os dois fundos
      let sandBed = texLin(texSand, bedPos.xz * 0.5);
      var bedAlb = mix(riverBedTex(bedPos.xz), sandBed * vec3<f32>(1.18, 1.08, 0.82), wSea) * 1.05;
      bedAlb *= 0.78 + 0.44 * noise3D(bedPos * 8.0);
      // Sol difuso no fundo sob a mesma sombra PCF + cintilação das cristas
      let caust = 0.80 + 0.45 * wH;
      let bedLight = (frame.sunColor.xyz * 2.2 * max(L.y, 0.0) * shadow + skyAmbient * 1.5) * caust;
      // Extinção espectral: azul some antes → chá esverdeado; absorção
      // mais forte para o leito não "passar por água seca" de cima
      var transmit = bedAlb * bedLight * exp2(-pathT * vec3<f32>(0.90, 1.15, 1.70) * 1.05);
      let fwd = pow(clamp(dot(-V, L), 0.0, 1.0), 2.0);
      // Rio: chá escuro esverdeado; mar: azul profundo — legível sob névoa
      let sedCol = mix(vec3<f32>(0.035, 0.095, 0.090), vec3<f32>(0.015, 0.08, 0.18), wSea);
      let scatter = (1.0 - exp(-pathT * 1.55)) * (0.55 + 0.45 * fwd) + 0.40 * (1.0 - wSea);
      transmit += sedCol
                * (frame.sunColor.xyz * 1.6 * max(L.y, 0.0) * shadow + skyAmbient * 1.2)
                * scatter;

      // Reflexo do céu + nuvens procedurais projetadas no plano a 240m
      let R = reflect(-V, N);
      var skyRefl = mix(frame.skyHorizonColor.xyz, frame.skyTopColor.xyz, pow(max(R.y, 0.0), 0.55));
      if (R.y > 0.02 && frame.params.w > 0.02) {
        let cHit = in.worldPos + R * ((240.0 - in.worldPos.y) / R.y);
        let dayAmtW = clamp(frame.params.w * 2.4 + 0.08, 0.0, 1.0);
        let cloudCol = mix(frame.skyHorizonColor.xyz, frame.skyTopColor.xyz, 0.4) * 0.62
                     + vec3<f32>(0.10) + frame.sunColor.xyz * 0.55 * dayAmtW;
        skyRefl = mix(skyRefl, cloudCol, cloudCoverage(cloudUV(cHit)) * 0.8);
      }
      // Brilho azimutal do horizonte na direção do sol (como no fsSky)
      let rAzim = normalize(vec3<f32>(R.x, 0.0, R.z) + vec3<f32>(0.001));
      let lAzim = normalize(vec3<f32>(L.x, 0.0, L.z) + vec3<f32>(0.001));
      skyRefl += frame.sunColor.xyz * pow(max(dot(rAzim, lAzim), 0.0), 2.5)
               * exp(-max(R.y, 0.0) * 5.0) * 0.18 * clamp(frame.params.w * 2.0, 0.0, 1.0);

      // Fresnel com piso: de cima o rio ainda reflete um pouco o céu
      let fresW = 0.08 + 0.92 * pow(1.0 - NdotV, 5.0);
      var waterCol = mix(transmit, skyRefl * (0.30 + 0.70 * shadow), fresW);

      // Espuma: filamentos rio abaixo + faixa na linha d'água (sem cobrir o leito)
      let edgeLine = smoothstep(0.0, 0.04, depthW) * (1.0 - smoothstep(0.06, 0.30, depthW));
      let foamAmt = clamp(
        wFoamBlend * (0.22 + 0.45 * clamp(depthW * 4.0, 0.0, 1.0)) * (0.35 + 0.65 * wFoam)
          + edgeLine * 0.55,
        0.0, 0.72
      );
      let foamCol = (frame.sunColor.xyz * 1.35 * max(NdotL, 0.12) * shadow + skyAmbient * 0.8)
                  * vec3<f32>(0.62, 0.66, 0.62);
      ambient = mix(waterCol, foamCol, foamAmt);
    }

    var color = ambient + Lo + emissive;

    // Neblina com extinção espectral (iq): azul extingue antes → distância ganha tom quente
    let dist = distToCam;
    let fogK = frame.params.z * 0.012;
    let ext = exp2(-dist * fogK * vec3<f32>(1.0, 1.4, 2.8));
    // Espalhamento direcional: a névoa brilha quando se olha na direção do sol
    let sunInsc = pow(clamp(dot(-V, L), 0.0, 1.0), 6.0);
    let dayAmt2 = clamp(frame.params.w * 2.0, 0.0, 1.0);
    let fogTint = frame.fogColor.xyz + frame.sunColor.xyz * sunInsc * 0.45 * dayAmt2;

    // Os god rays volumétricos rodam agora no passe de composição a partir
    // da posição reconstruída do depth: idêntico por pixel, mas avaliado
    // 1x em vez de 1x por fragmento sobreposto de terreno/folhagem.
    color = color * ext + fogTint * (vec3<f32>(1.0) - ext);

    // Saída em Linear HDR (será processada pelo Bloom e ACES Tone Mapping)
    return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
  }

  // Densidade volumétrica 3D (estilo iq "Clouds"): FBM 3D forma cúmulos de
  // verdade — não colunas. Erosão por oitava fina + gradiente de altura.
  fn cloudDens(p: vec3<f32>) -> f32 {
    let h = clamp((p.y - 240.0) / 180.0, 0.0, 1.0);
    if (h <= 0.0 || h >= 1.0) { return 0.0; }
    let wind = vec3<f32>(frame.params.x * 0.9, 0.0, frame.params.x * 0.4) * 0.01;
    var q = p * 0.008 + wind;
    var f = fbm3(q * 1.35);
    if (f < 0.47) { return 0.0; } // nem com a erosão cheia passa do limiar
    f += fbm3(q * 4.2) * 0.38; // erosão das bordas
    // Forma de cúmulo: base achatada, topo arredondado
    let hg = smoothstep(0.0, 0.28, h) * (1.0 - smoothstep(0.55, 1.0, h));
    return max(0.0, f - 0.80) * hg * 5.0;
  }

  // --- SHADER DE CÉU ATMOSFÉRICO & DISCO SOLAR ---
  struct SkyOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) ndc: vec2<f32>,
  };

  @vertex
  fn vsSky(@builtin(vertex_index) vIdx: u32) -> SkyOut {
    var pos = array<vec2<f32>, 3>(
      vec2<f32>(-1.0, -1.0),
      vec2<f32>(3.0, -1.0),
      vec2<f32>(-1.0, 3.0)
    );
    var out: SkyOut;
    out.clipPos = vec4<f32>(pos[vIdx], 0.9999, 1.0);
    out.ndc = pos[vIdx];
    return out;
  }

  @fragment
  fn fsSky(in: SkyOut) -> @location(0) vec4<f32> {
    let worldNear = frame.invViewProj * vec4<f32>(in.ndc, 0.0, 1.0);
    let worldFar  = frame.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
    let rayDir = normalize((worldFar.xyz / worldFar.w) - (worldNear.xyz / worldNear.w));

    let L = normalize(frame.sunDir.xyz);
    let elev = frame.params.w;
    let dayAmt = clamp(elev * 2.4 + 0.08, 0.0, 1.0);
    let golden = exp(-pow((elev - 0.16) / 0.22, 2.0));

    // Gradiente atmosférico zenite -> horizonte
    var col = mix(frame.skyHorizonColor.xyz, frame.skyTopColor.xyz, pow(max(rayDir.y, 0.0), 0.55));
    col *= 1.0 - smoothstep(0.0, -0.3, rayDir.y) * 0.45;

    // Espalhamento do horizonte concentrado no azimute do sol
    let horizDir = vec3<f32>(rayDir.x, 0.0, rayDir.z) / max(length(rayDir.xz), 0.001);
    let sunHoriz = vec3<f32>(L.x, 0.0, L.z) / max(length(L.xz), 0.001);
    let azAmt = max(dot(horizDir, sunHoriz), 0.0);
    let horizGlow = pow(azAmt, 2.5) * exp(-max(rayDir.y, 0.0) * 5.0);
    col += frame.sunColor.xyz * horizGlow * (0.22 + golden * 0.75) * max(dayAmt, 0.15);

    // Disco Solar nítido + halo médio + aura ampla atmosférica
    let sunAmt = max(dot(rayDir, L), 0.0);
    let sunDisc = smoothstep(0.9993, 0.9997, sunAmt) * 14.0;
    let sunHalo = pow(sunAmt, 20.0) * 0.9 + pow(sunAmt, 220.0) * 4.0;
    let sunGlow = pow(sunAmt, 5.0) * 0.22 * (0.4 + golden * 0.6);
    col += frame.sunColor.xyz * (sunDisc + sunHalo + sunGlow) * max(elev + 0.15, 0.0);

    // Nuvens volumétricas raymarchadas (camada 240m–420m): Beer + luz solar marchada
    if (rayDir.y > 0.015) {
      let camP = frame.cameraPos.xyz;
      let tA = (240.0 - camP.y) / rayDir.y;
      let tB = (420.0 - camP.y) / rayDir.y;
      var t0 = max(tA, 0.0);
      var t1 = min(tB, t0 + 400.0);
      if (t1 > t0) {
        var T = 1.0;
        var acc = vec3<f32>(0.0);
        let STEPS = 32;
        let dt = (t1 - t0) / f32(STEPS);
        // Jitter por pixel: elimina bandas/contornos da marcha
        let jit = fract(sin(dot(in.clipPos.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453);
        for (var i = 0; i < STEPS; i++) {
          if (T < 0.04) { break; }
          let p = camP + rayDir * (t0 + (f32(i) + jit) * dt);
          let d = cloudDens(p);
          if (d > 0.008) {
            // Marcha curta na direção do sol: núcleo escuro, borda iluminada
            var dL = 0.0;
            dL += cloudDens(p + L * 5.0);
            dL += cloudDens(p + L * 12.0);
            let litF = exp(-dL * 0.22);
            // Ambiente branco-azulado (luz do céu espalhada), não cinza-chumbo
            let amb = mix(frame.skyHorizonColor.xyz, frame.skyTopColor.xyz, 0.4) * 0.62 + vec3<f32>(0.10);
            let sun = frame.sunColor.xyz * (1.7 * pow(litF, 1.4) + 0.10) * max(dayAmt, 0.06);
            // Bordas translúcidas brilham (powder) + brilho prateado ao olhar para o sol
            let powder = 1.0 - exp(-d * 3.0);
            let silver = frame.sunColor.xyz * pow(sunAmt, 7.0) * 0.5 * dayAmt;
            let S = (amb + sun + silver) * d * powder;
            acc += T * S * dt * 0.62;
            T *= exp(-d * 0.55 * dt);
          }
        }
        let fade = exp(-t0 * 0.0005) * smoothstep(0.015, 0.12, rayDir.y);
        col = col * mix(1.0, T, fade) + acc * fade;
      }
    }

    // Estrelas cintilantes durante a noite + campo estelar fotográfico
    let night = clamp(1.0 - elev * 3.0, 0.0, 1.0);
    if (night > 0.01 && rayDir.y > 0.02) {
      let eq = vec2<f32>(atan2(rayDir.z, rayDir.x) / 6.2831853 + 0.5, rayDir.y * 0.5 + 0.5);
      let milky = texLin(texStars, eq * vec2<f32>(2.0, 1.0));
      col += milky * night * smoothstep(0.02, 0.22, rayDir.y) * 1.6;
      let sp = rayDir * 190.0;
      let h = hash31(floor(sp));
      if (h > 0.985) {
        let g = fract(sp) - 0.5;
        let star = smoothstep(0.32, 0.02, length(g));
        let tw = 0.65 + 0.35 * sin(frame.params.x * 2.6 + h * 57.0);
        col += vec3<f32>(0.85, 0.92, 1.0) * star * tw * night * smoothstep(0.02, 0.18, rayDir.y);
      }
    }

    return vec4<f32>(max(col, vec3<f32>(0.0)), 1.0);
  }

  // --- SHADER DE ESPOROS & VAGALUMES HDR ---
  struct SporeOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) localUV: vec2<f32>,
    @location(1) alpha: f32,
    @location(2) color: vec3<f32>,
  };

  @vertex
  fn vsSpores(@builtin(vertex_index) vIdx: u32, @location(0) sporeData: vec4<f32>) -> SporeOut {
    var out: SporeOut;
    var offsets = array<vec2<f32>, 6>(
      vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
      vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
    );
    let uv = offsets[vIdx];
    let t = frame.params.x * 0.65 + sporeData.w;
    let drift = vec3<f32>(
      sin(t * 1.1 + sporeData.w) * 1.5,
      sin(t * 0.8 + sporeData.x) * 0.9,
      cos(t * 0.95 + sporeData.z) * 1.5
    );
    let worldCenter = sporeData.xyz + drift;
    let toCam = normalize(frame.cameraPos.xyz - worldCenter);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), toCam));
    let up = cross(toCam, right);

    let isNight = clamp(1.0 - frame.params.w * 2.2, 0.0, 1.0);
    let pulse = 0.55 + 0.45 * sin(frame.params.x * 2.5 + sporeData.w * 3.0);
    let size = mix(0.04, 0.085, isNight) * pulse;
    let worldPos = worldCenter + (right * uv.x + up * uv.y) * size;

    out.clipPos = frame.viewProj * vec4<f32>(worldPos, 1.0);
    out.localUV = uv;
    out.alpha = pulse * mix(0.45, 0.98, isNight);
    out.color = mix(vec3<f32>(1.0, 0.90, 0.60), vec3<f32>(0.42, 1.0, 0.65), isNight);
    return out;
  }

  @fragment
  fn fsSpores(in: SporeOut) -> @location(0) vec4<f32> {
    let d = length(in.localUV);
    if (d > 1.0) { discard; }
    let glow = pow(1.0 - d, 2.4) * in.alpha;
    return vec4<f32>(in.color * glow * 3.2, glow);
  }
`;

export const WGSL_POST_SHADERS = /* wgsl */`
  struct PostUniforms {
    direction: vec2<f32>,
    threshold: f32,
    bloomIntensity: f32,
  };

  struct FrameView {
    viewProj: mat4x4<f32>,
    invViewProj: mat4x4<f32>,
    lightViewProj: mat4x4<f32>,
    cameraPos: vec4<f32>,
    sunDir: vec4<f32>,
    sunColor: vec4<f32>,
    skyTopColor: vec4<f32>,
    skyHorizonColor: vec4<f32>,
    fogColor: vec4<f32>,
    params: vec4<f32>,
    params2: vec4<f32>,
  };

  @group(0) @binding(0) var<uniform> post: PostUniforms;
  @group(0) @binding(1) var srcTex: texture_2d<f32>;
  @group(0) @binding(2) var bloomTex: texture_2d<f32>;
  @group(0) @binding(3) var linSampler: sampler;
  @group(0) @binding(4) var depthTex: texture_2d<f32>;
  @group(0) @binding(5) var<uniform> frame2: FrameView;
  @group(0) @binding(6) var shadowMap: texture_depth_2d;
  @group(0) @binding(7) var shadowSampler: sampler_comparison;

  // Reconstrói posição em mundo a partir de UV de tela + profundidade
  fn worldFromDepth(uv: vec2<f32>, d: f32) -> vec3<f32> {
    let ndc = vec3<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d);
    let w = frame2.invViewProj * vec4<f32>(ndc, 1.0);
    return w.xyz / w.w;
  }

  fn hash12(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
  }

  // --- RAYMARCHING VOLUMÉTRICO DE RAIOS CREPUSCULARES (GOD RAYS) ---
  // Mesmo cálculo que rodava no fsMain, agora 1x por pixel aqui no pós:
  // o depth reconstrói o worldPos do fragmento vencedor do z-test, então
  // o resultado é idêntico sem pagar o custo por cada camada de folhagem.
  fn computeGodRays(worldPos: vec3<f32>) -> vec3<f32> {
    if (frame2.params.z < 0.01) { return vec3<f32>(0.0); } // sem névoa, sem raio
    let rayStart = frame2.cameraPos.xyz;
    let rayVec = worldPos - rayStart;
    let totalDist = min(length(rayVec), 95.0);
    let rayDir = rayVec / max(length(rayVec), 0.0001);
    let L = normalize(frame2.sunDir.xyz);

    // Fase de Mie (forte espalhamento frontal quando olhando na direção do sol)
    let cosTheta = dot(rayDir, L);
    let g = 0.72;
    let miePhase = (1.0 - g * g) / (4.0 * 3.14159 * pow(max(1.0 + g * g - 2.0 * g * cosTheta, 0.05), 1.5));

    let steps = i32(frame2.params2.x);
    let stepSize = totalDist / f32(max(steps, 1));
    // Dither espacial para eliminar banding
    let dither = fract(sin(dot(worldPos.xz, vec2<f32>(12.9898, 78.233))) * 43758.5453);

    var accumLight = 0.0;
    for (var i = 0; i < steps; i++) {
      let t = (f32(i) + dither) * stepSize;
      let samplePos = rayStart + rayDir * t;

      let lightClip = frame2.lightViewProj * vec4<f32>(samplePos, 1.0);
      let proj = lightClip.xyz / lightClip.w;
      let suv = vec2<f32>(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);

      var inSun = 1.0;
      if (suv.x > 0.01 && suv.x < 0.99 && suv.y > 0.01 && suv.y < 0.99 && proj.z > 0.0 && proj.z < 1.0) {
        inSun = textureSampleCompareLevel(shadowMap, shadowSampler, suv, proj.z - 0.002);
      }
      // Densidade maior próxima ao solo úmido
      let heightDensity = exp(-max(samplePos.y + 2.0, 0.0) * 0.08);
      accumLight += inSun * heightDensity;
    }

    let transmittance = (accumLight / f32(max(steps, 1))) * totalDist * 0.018;
    let rayStrength = transmittance * (0.35 + miePhase * 1.45) * frame2.params.z * max(frame2.params.w, 0.08);
    return frame2.sunColor.xyz * rayStrength;
  }

  // SSAO em espaço de mundo: hemisfério orientado à normal reconstruída do depth
  fn computeSSAO(uv: vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(depthTex));
    let ipos = vec2<i32>(uv * dims);
    let d0 = textureLoad(depthTex, ipos, 0).x;
    if (d0 >= 0.9999) { return 1.0; } // céu: sem oclusão

    let P = worldFromDepth(uv, d0);
    let dist = length(P - frame2.cameraPos.xyz);
    let distFade = 1.0 - smoothstep(25.0, 90.0, dist);
    if (distFade <= 0.001) { return 1.0; }

    // Normal a partir de vizinhos de depth
    let texel = 1.0 / dims;
    let posR = worldFromDepth(uv + vec2<f32>(texel.x, 0.0), textureLoad(depthTex, ipos + vec2<i32>(1, 0), 0).x);
    let posL = worldFromDepth(uv - vec2<f32>(texel.x, 0.0), textureLoad(depthTex, ipos - vec2<i32>(1, 0), 0).x);
    let posU = worldFromDepth(uv + vec2<f32>(0.0, texel.y), textureLoad(depthTex, ipos + vec2<i32>(0, 1), 0).x);
    let posD = worldFromDepth(uv - vec2<f32>(0.0, texel.y), textureLoad(depthTex, ipos - vec2<i32>(0, 1), 0).x);
    var N = normalize(cross(posR - posL, posU - posD));
    if (dot(N, frame2.cameraPos.xyz - P) < 0.0) { N = -N; }

    // Base tangente + jitter de rotação por pixel
    let jit = hash12(uv * dims + frame2.params.x);
    let ca = cos(jit * 6.2831);
    let sa = sin(jit * 6.2831);
    var upv = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(N.y) > 0.95) { upv = vec3<f32>(1.0, 0.0, 0.0); }
    let T = normalize(cross(N, upv));
    let B = cross(N, T);

    let R = 1.1;
    var occ = 0.0;
    for (var i = 0; i < 16; i++) {
      let fi = f32(i);
      // Espiral de Fibonacci no hemisfério
      let rr = (fi + 0.5) / 16.0;
      let ang = fi * 2.399963;
      let ca2 = cos(ang) * ca - sin(ang) * sa;
      let sa2 = sin(ang) * ca + cos(ang) * sa;
      let dir = vec3<f32>(ca2 * rr, sa2 * rr, 1.0 - rr);
      let sampPos = P + (T * dir.x + B * dir.y + N * dir.z) * R;

      let clip = frame2.viewProj * vec4<f32>(sampPos, 1.0);
      if (clip.w <= 0.0) { continue; }
      let sndc = clip.xyz / clip.w;
      let suv = vec2<f32>(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 || sndc.z < 0.0) { continue; }

      let sd = textureLoad(depthTex, clamp(vec2<i32>(suv * dims), vec2<i32>(0), vec2<i32>(dims) - 1), 0).x;
      if (sd < sndc.z - 0.0012) { occ += 1.0; }
    }
    return mix(1.0, 1.0 - occ * (1.0 / 16.0) * 0.75, distFade);
  }

  struct FullscreenOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
  };

  @vertex
  fn vsFullscreen(@builtin(vertex_index) vIdx: u32) -> FullscreenOut {
    var pos = array<vec2<f32>, 3>(
      vec2<f32>(-1.0, -1.0),
      vec2<f32>(3.0, -1.0),
      vec2<f32>(-1.0, 3.0)
    );
    var out: FullscreenOut;
    out.clipPos = vec4<f32>(pos[vIdx], 0.0, 1.0);
    out.uv = vec2<f32>(pos[vIdx].x * 0.5 + 0.5, 0.5 - pos[vIdx].y * 0.5);
    return out;
  }

  // Extração de altas luzes HDR para Bloom — e SSAO no canal alpha:
  // este passe já roda em meia-resolução, então o AO sai a 1/4 do custo
  // de tela cheia e ainda recebe o blur gaussiano do bloom de graça
  @fragment
  fn fsBloomExtract(in: FullscreenOut) -> @location(0) vec4<f32> {
    let col = textureSample(srcTex, linSampler, in.uv).rgb;
    let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    let contrib = max(0.0, luma - post.threshold) / max(luma, 0.0001);
    return vec4<f32>(col * contrib, computeSSAO(in.uv));
  }

  // Desfoque Gaussiano Separável (9-tap) — rgba: o alpha carrega o SSAO
  @fragment
  fn fsBlur(in: FullscreenOut) -> @location(0) vec4<f32> {
    let texel = post.direction / vec2<f32>(textureDimensions(srcTex));
    var weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    var result = textureSample(srcTex, linSampler, in.uv) * weights[0];
    for (var i = 1; i < 5; i++) {
      let off = texel * f32(i) * 1.8;
      result += textureSample(srcTex, linSampler, in.uv + off) * weights[i];
      result += textureSample(srcTex, linSampler, in.uv - off) * weights[i];
    }
    return result;
  }

  // Composição Final: HDR + Bloom + Aberração Cromática Sutil + ACES Tone Mapping + Vinheta
  @fragment
  fn fsComposite(in: FullscreenOut) -> @location(0) vec4<f32> {
    let centered = in.uv - 0.5;
    let distSq = dot(centered, centered);
    let caOffset = centered * distSq * 0.0045;

    let r = textureSample(srcTex, linSampler, in.uv + caOffset).r;
    let g = textureSample(srcTex, linSampler, in.uv).g;
    let b = textureSample(srcTex, linSampler, in.uv - caOffset).b;
    var hdrColor = vec3<f32>(r, g, b);

    // God rays 1x por pixel a partir da posição reconstruída do depth
    // (só o céu fica com o depth limpo = 1.0 exato — e o fsSky nunca os teve)
    let dDims = vec2<f32>(textureDimensions(depthTex));
    let ipos = clamp(vec2<i32>(in.uv * dDims), vec2<i32>(0), vec2<i32>(dDims) - 1);
    let d0 = textureLoad(depthTex, ipos, 0).x;
    if (d0 < 1.0) {
      hdrColor += computeGodRays(worldFromDepth(in.uv, d0));
    }

    // Bloom rgb + Oclusão ambiental de tela viajando no alpha (meia-res
    // com blur grátis): contato/crevises escurecem antes do bloom
    let bloom = textureSample(bloomTex, linSampler, in.uv);
    hdrColor *= bloom.a;
    hdrColor += bloom.rgb * post.bloomIntensity;

    // Vinheta óptica cinematográfica
    let vignette = 1.0 - distSq * 0.52;
    hdrColor *= clamp(vignette, 0.45, 1.0);

    // ACES Filmic Tone Mapping
    let mapped = (hdrColor * (2.51 * hdrColor + 0.03)) / (hdrColor * (2.43 * hdrColor + 0.59) + 0.14);
    let gammaCorrected = pow(max(mapped, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
    return vec4<f32>(gammaCorrected, 1.0);
  }
`;
