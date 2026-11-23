// ============================================================================
// shaders.js — Shaders PBR Cook-Torrance GGX, Shadow Mapping PCF 3x3,
// Céu Atmosférico com Nuvens Procedurais, Sombras de Nuvens e Estrelas,
// Volumetric God Rays Raymarching e Pós-Processamento HDR Bloom (WGSL)
// ============================================================================

export const WGSL_SHADERS = /* wgsl */`
  struct FrameUniforms {
    viewProj: mat4x4<f32>,
    invViewProj: mat4x4<f32>,
    lightViewProj: mat4x4<f32>,
    cameraPos: vec4<f32>,
    sunDir: vec4<f32>,
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

  // --- CAMADA DE NUVENS PROCEDURAIS (plano a 55m, FBM rotacionado advectado pelo vento) ---
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
        (mat == 7 && leafSilhouetteRound(in.uv) < 0.0)) {
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
    let scale = inst.instPosScale.w;

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
    out.color = in.color * inst.instMeta.z;
    out.uv = in.uv;
    out.matId = in.matId;
    // Variação determinística de matiz por instância (copas da mesma árvore variam sutilmente)
    out.hueJit = fract(sin(dot(inst.instPosScale.xz, vec2<f32>(12.9898, 78.233))) * 43758.5453);
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

  // --- RAYMARCHING VOLUMÉTRICO DE RAIOS CREPUSCULARES (GOD RAYS) ---
  fn computeVolumetricGodRays(worldPos: vec3<f32>) -> vec3<f32> {
    let rayStart = frame.cameraPos.xyz;
    let rayVec = worldPos - rayStart;
    let totalDist = min(length(rayVec), 95.0);
    let rayDir = rayVec / max(length(rayVec), 0.0001);
    let L = normalize(frame.sunDir.xyz);

    // Fase de Mie (forte espalhamento frontal quando olhando na direção do sol)
    let cosTheta = dot(rayDir, L);
    let g = 0.72;
    let miePhase = (1.0 - g * g) / (4.0 * 3.14159 * pow(max(1.0 + g * g - 2.0 * g * cosTheta, 0.05), 1.5));

    let steps = i32(frame.params2.x);
    let stepSize = totalDist / f32(max(steps, 1));
    // Dither espacial para eliminar banding
    let dither = fract(sin(dot(worldPos.xz, vec2<f32>(12.9898, 78.233))) * 43758.5453);

    var accumLight = 0.0;
    for (var i = 0; i < steps; i++) {
      let t = (f32(i) + dither) * stepSize;
      let samplePos = rayStart + rayDir * t;

      let lightClip = frame.lightViewProj * vec4<f32>(samplePos, 1.0);
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
    let rayStrength = transmittance * (0.35 + miePhase * 1.45) * frame.params.z * max(frame.params.w, 0.08);
    return frame.sunColor.xyz * rayStrength;
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

    let mat = i32(in.matId + 0.5);
    let distToCam = length(in.worldPos - frame.cameraPos.xyz);
    // Fade do detalhe fino com a distância: evita cintilação (shimmer)
    let detailFade = 1.0 / (1.0 + distToCam * 0.04);

    // Recorte da silhueta da folha na copa, com borda erodida por ruído real
    // (silhueta irregular orgânica em vez de curva matemática limpa)
    let edgeN = textureSampleLevel(texNoise, texSamp, in.uv * 3.0 + vec2<f32>(in.hueJit * 37.0, in.hueJit * 11.0), 0.0).r;
    if ((mat == 2 && leafSilhouette(in.uv) < (edgeN - 0.5) * 0.11) ||
        (mat == 7 && leafSilhouetteRound(in.uv) < (edgeN - 0.5) * 0.11)) {
      discard;
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
        let bandN = fbm3(wp * vec3<f32>(0.55, 0.22, 0.55) + vec3<f32>(7.7));
        let band = 0.5 + 0.5 * sin(wp.y * 2.6 + bandN * 7.0);
        let rockGrain = noise3D(wp * 26.0);
        // Textura de rocha real projetada verticalmente: estratos seguem a altitude
        let rt = texLin(texRock, vec2<f32>(wp.x * 0.6 + wp.z * 0.4, wp.y * 0.9) * 0.20);
        let rockCol = rt * (0.40 + 0.85 * band) * (0.72 + 0.56 * rockGrain);
        albedo = mix(albedo, rockCol, rockAmt * 0.9);
        roughness = mix(roughness, 0.88, rockAmt);
        bump += (band * 0.22 + dot(rt, vec3<f32>(0.33)) * 0.3) * rockAmt;
      }

      // Chão do vale: serrapilheira + galharia fotográficas (só em baixa altitude
      // e encosta suave — não nas encostas rochosas do maciço)
      let valleyAmt = (1.0 - rockAmt) * smoothstep(17.0, 7.0, wp.y);
      if (valleyAmt > 0.0) {
        let litT = texLin(texLitter, wp.xz * 0.115);
        let litLum = dot(litT, vec3<f32>(0.299, 0.587, 0.114));
        let twg = texLin(texTwigs, wp.xz * 0.31 + vec2<f32>(0.4, 0.7));
        let twgLum = dot(twg, vec3<f32>(0.33));
        albedo = mix(albedo, litT * (0.62 + 0.55 * soilMacro), valleyAmt * 0.50);
        albedo = mix(albedo, twg * (0.45 + 0.45 * micro), valleyAmt * smoothstep(0.52, 0.78, grain) * 0.35);
        bump += (litLum * 0.30 + twgLum * 0.40) * valleyAmt;
      }

      // Leito do riacho: seixos molhados fotográficos + superfície úmida
      let wet = smoothstep(-0.9, -2.0, wp.y);
      if (wet > 0.0) {
        let ws = texLin(texWet, wp.xz * 0.30);
        let wsLum = dot(ws, vec3<f32>(0.33));
        albedo = mix(albedo, ws * 0.80, wet * 0.75);
        roughness = mix(roughness, 0.28, wet * 0.8);
        bump += wsLum * 0.45 * wet;
      }
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
    } else if (mat == 2 || mat == 3 || mat == 7) {
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
      albedo += vec3<f32>(0.030, 0.048, 0.008) * veins;

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
      let mossAmt = smoothstep(0.45, 0.85, max(0.0, in.worldNormal.y) * (0.55 + 0.9 * fbm3(wp * 1.8)));
      albedo = mix(albedo, vec3<f32>(0.09, 0.18, 0.06), mossAmt * 0.65);
      roughness = mix(0.72, 0.95, max(max(0.0, N.y), mossAmt));
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
      // Riacho com Ondulações Normais Animadas & Reflexo Fresnel
      let t = frame.params.x * 1.4;
      let w1 = sin(in.worldPos.x * 3.8 + t * 2.2 + cos(in.worldPos.z * 2.9 - t));
      let w2 = cos(in.worldPos.z * 4.6 - t * 2.8 + sin(in.worldPos.x * 3.1));
      let w3 = noise3D(vec3<f32>(in.worldPos.x * 12.0, t * 0.7, in.worldPos.z * 12.0)) - 0.5;
      N = normalize(vec3<f32>(w1 * 0.05 + w3 * 0.10, 1.0, w2 * 0.05 + w3 * 0.06));
      roughness = 0.08;
      albedo = vec3<f32>(0.02, 0.06, 0.05);
    }

    N = normalize(N + (dpdx(bump) + dpdy(bump)) * bumpScale * detailFade);

    // Sombra Real Direcional PCF 3x3
    var shadow = sampleShadowPCF(in.worldPos, N, L);

    // Sombras projetadas das nuvens: interseção do raio sol->fragmento com o plano a 55m
    if (L.y > 0.06) {
      let cloudHit = in.worldPos + L * ((55.0 - in.worldPos.y) / L.y);
      let cShadow = 1.0 - cloudCoverage(cloudUV(cloudHit)) * 0.62 * clamp(frame.params.w * 2.0, 0.0, 1.0);
      shadow *= cShadow;
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
    if (mat == 2 || mat == 3 || mat == 7) {
      let backScatter = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0) * (0.4 + 0.6 * in.uv.y);
      let sss = vec3<f32>(0.36, 0.72, 0.16) * frame.sunColor.xyz * backScatter * (0.35 + 0.65 * shadow) * 1.1;
      Lo += sss;
    }

    // Iluminação Ambiente Hemisférica + Reflexo Celeste na Água
    let hemi = N.y * 0.5 + 0.5;
    let skyAmbient = mix(vec3<f32>(0.04, 0.08, 0.06), frame.skyTopColor.xyz * 0.55 + vec3<f32>(0.05, 0.13, 0.08), hemi);
    var ambient = skyAmbient * albedo * ao;

    if (mat == 6) {
      let fresnelWater = fresnelSchlick(NdotV, vec3<f32>(0.02));
      let skyRefl = mix(frame.skyHorizonColor.xyz, frame.skyTopColor.xyz, 0.45) * (0.35 + 0.65 * shadow);
      ambient += skyRefl * fresnelWater * 1.8;
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
    let godRays = computeVolumetricGodRays(in.worldPos);

    color = color * ext + fogTint * (vec3<f32>(1.0) - ext) + godRays;

    // Saída em Linear HDR (será processada pelo Bloom e ACES Tone Mapping)
    return vec4<f32>(max(color, vec3<f32>(0.0)), 1.0);
  }

  // Densidade volumétrica 3D (estilo iq "Clouds"): FBM 3D forma cúmulos de
  // verdade — não colunas. Erosão por oitava fina + gradiente de altura.
  fn cloudDens(p: vec3<f32>) -> f32 {
    let h = clamp((p.y - 45.0) / 70.0, 0.0, 1.0);
    if (h <= 0.0 || h >= 1.0) { return 0.0; }
    let wind = vec3<f32>(frame.params.x * 0.9, 0.0, frame.params.x * 0.4) * 0.01;
    var q = p * 0.009 + wind;
    var f = fbm3(q * 1.35);
    f += fbm3(q * 4.2) * 0.38; // erosão das bordas
    // Forma de cúmulo: base achatada, topo arredondado
    let hg = smoothstep(0.0, 0.28, h) * (1.0 - smoothstep(0.55, 1.0, h));
    return max(0.0, f - 0.74) * hg * 3.4;
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

    // Nuvens volumétricas raymarchadas (camada 45m–115m): Beer + luz solar marchada
    if (rayDir.y > 0.015) {
      let camP = frame.cameraPos.xyz;
      let tA = (45.0 - camP.y) / rayDir.y;
      let tB = (115.0 - camP.y) / rayDir.y;
      var t0 = max(tA, 0.0);
      var t1 = min(tB, t0 + 400.0);
      if (t1 > t0) {
        var T = 1.0;
        var acc = vec3<f32>(0.0);
        let STEPS = 44;
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
            let litF = exp(-dL * 0.16);
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
        let fade = exp(-t0 * 0.0016) * smoothstep(0.015, 0.12, rayDir.y);
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

  // Reconstrói posição em mundo a partir de UV de tela + profundidade
  fn worldFromDepth(uv: vec2<f32>, d: f32) -> vec3<f32> {
    let ndc = vec3<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d);
    let w = frame2.invViewProj * vec4<f32>(ndc, 1.0);
    return w.xyz / w.w;
  }

  fn hash12(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
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

  // Extração de altas luzes HDR para Bloom
  @fragment
  fn fsBloomExtract(in: FullscreenOut) -> @location(0) vec4<f32> {
    let col = textureSample(srcTex, linSampler, in.uv).rgb;
    let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    let contrib = max(0.0, luma - post.threshold) / max(luma, 0.0001);
    return vec4<f32>(col * contrib, 1.0);
  }

  // Desfoque Gaussiano Separável (9-tap)
  @fragment
  fn fsBlur(in: FullscreenOut) -> @location(0) vec4<f32> {
    let texel = post.direction / vec2<f32>(textureDimensions(srcTex));
    var weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    var result = textureSample(srcTex, linSampler, in.uv).rgb * weights[0];
    for (var i = 1; i < 5; i++) {
      let off = texel * f32(i) * 1.8;
      result += textureSample(srcTex, linSampler, in.uv + off).rgb * weights[i];
      result += textureSample(srcTex, linSampler, in.uv - off).rgb * weights[i];
    }
    return vec4<f32>(result, 1.0);
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

    // Oclusão ambiental de tela: contato/crevises escurecem antes do bloom
    hdrColor *= computeSSAO(in.uv);

    let bloom = textureSample(bloomTex, linSampler, in.uv).rgb;
    hdrColor += bloom * post.bloomIntensity;

    // Vinheta óptica cinematográfica
    let vignette = 1.0 - distSq * 0.52;
    hdrColor *= clamp(vignette, 0.45, 1.0);

    // ACES Filmic Tone Mapping
    let mapped = (hdrColor * (2.51 * hdrColor + 0.03)) / (hdrColor * (2.43 * hdrColor + 0.59) + 0.14);
    let gammaCorrected = pow(max(mapped, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
    return vec4<f32>(gammaCorrected, 1.0);
  }
`;
