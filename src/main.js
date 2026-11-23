// ============================================================================
// main.js — Orquestrador WebGPU (Shadow Map + HDR + Bloom + God Rays),
// Controles e Exportador ZIP Modular
// ============================================================================

import { Mat4 } from './math.js';
import { QUALITY_PRESETS } from './quality.js';
import { ForestWorld } from './world.js';
import { WGSL_SHADERS, WGSL_POST_SHADERS } from './shaders.js';
import { ForestAudio } from './audio.js';

// Camadas instanciadas: [mesh, lista de instâncias, pipeline, faixa, sombra].
// A faixa decide quais células da grade do mundo entram no frame, pela
// distância à câmera: 'near' = copa em detalhe cheio até detailDist;
// 'mid' = copa de cartões planos daí até lodDist; 'tree' = near + mid
// (tronco completo); 'far' = LOD distante além de lodDist; 'under' =
// sub-bosque até understoryDist; 'all' = toda célula dentro do frustum.
// Níveis de detalhe da mesma árvore dividem a mesma lista de instâncias.
// A sombra usa sempre a copa de cartões planos (mesmas folhas, 6× mais leve)
const INSTANCE_LAYERS = [
  ['trunkA', 'trunksA', 'solid', 'tree', true],
  ['trunkB', 'trunksB', 'solid', 'tree', true],
  ['trunkAFar', 'trunksA', 'solid', 'far', false],
  ['trunkBFar', 'trunksB', 'solid', 'far', false],
  ['trunkC', 'trunksC', 'solid', 'tree', true],
  ['trunkCFar', 'trunksC', 'solid', 'far', false],
  ['rock', 'rocks', 'solid', 'all', true],
  ['log', 'logs', 'solid', 'tree', true],
  ['mushroom', 'mushrooms', 'solid', 'under', false],
  ['canopyA', 'canopiesA', 'foliage', 'near', false],
  ['canopyB', 'canopiesB', 'foliage', 'near', false],
  ['canopyAMid', 'canopiesA', 'foliage', 'mid', true],
  ['canopyBMid', 'canopiesB', 'foliage', 'mid', true],
  ['canopyAFar', 'canopiesAFar', 'foliage', 'far', false],
  ['canopyBFar', 'canopiesBFar', 'foliage', 'far', false],
  ['canopyC', 'canopiesC', 'foliage', 'near', false],
  ['canopyCMid', 'canopiesC', 'foliage', 'mid', true],
  ['canopyCFar', 'canopiesCFar', 'foliage', 'far', false],
  ['fern', 'ferns', 'foliage', 'under', false],
  ['grass', 'grasses', 'foliage', 'under', false],
  ['bush', 'bushes', 'foliage', 'under', false],
  ['reed', 'reeds', 'foliage', 'under', false],
  ['broadleaf', 'broadleafs', 'foliage', 'under', false]
];

// Planos normalizados (a,b,c,d) de uma view-projection WebGPU (z de 0 a 1)
// guardada em m[o..o+15]: esquerda, direita, baixo, cima e, com `depth`,
// perto e longe. Devolve quantos planos escreveu em `out`
function frustumPlanes(m, o, out, depth) {
  const count = depth ? 6 : 4;
  for (let i = 0; i < count; i++) {
    // Plano i = w ± (linha x | y | z) da matriz; o de perto é só a linha z
    const r = i >> 1, s = i & 1 ? -1 : 1, w = i === 4 ? 0 : 1;
    const a = w * m[o + 3] + s * m[o + r], b = w * m[o + 7] + s * m[o + 4 + r];
    const c = w * m[o + 11] + s * m[o + 8 + r], d = w * m[o + 15] + s * m[o + 12 + r];
    const len = Math.hypot(a, b, c) || 1;
    out[i * 4] = a / len; out[i * 4 + 1] = b / len; out[i * 4 + 2] = c / len; out[i * 4 + 3] = d / len;
  }
  return count;
}

function sphereInPlanes(planes, count, x, y, z, r) {
  for (let i = 0; i < count; i++) {
    if (planes[i * 4] * x + planes[i * 4 + 1] * y + planes[i * 4 + 2] * z + planes[i * 4 + 3] < -r) return false;
  }
  return true;
}

class WebGPURenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.api = 'WebGPU HDR';
    this.device = null;
    this.context = null;
    this.format = null;
    this.shadowRes = 2048;
  }

  async init(shadowRes = 2048, onProgress = null) {
    if (!navigator.gpu) return false;
    try {
      onProgress?.(0.05, 'Solicitando GPU…');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return false;
      this.device = await adapter.requestDevice();
      onProgress?.(0.15, 'Configurando canvas…');
      this.context = this.canvas.getContext('webgpu');
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque'
      });
      this.shadowRes = shadowRes;
      await this.loadTextures((f) => onProgress?.(0.15 + f * 0.6, 'Carregando texturas…'));
      onProgress?.(0.8, 'Compilando shaders…');
      await new Promise(r => requestAnimationFrame(r));
      this.createPipelines();
      onProgress?.(1);
      return true;
    } catch (e) {
      console.warn('WebGPU indisponível:', e);
      return false;
    }
  }

  async loadTextures(onProgress = null) {
    // Texturas fotográficas do pacote de mídia do Shadertoy (espelhadas localmente)
    const files = [
      'textures/bark.jpg', 'textures/rock.jpg', 'textures/pebbles.png', 'textures/noise.png',
      'textures/litter.jpg', 'textures/wetstones.jpg', 'textures/twigs.jpg', 'textures/bark2.jpg',
      'textures/granite.jpg', 'textures/graynoise.png', 'textures/wood.jpg', 'textures/sand.png'
    ];
    this.textureViews = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const bmp = await createImageBitmap(await (await fetch(f)).blob(), { colorSpaceConversion: 'none' });
        const tex = this.device.createTexture({
          size: [bmp.width, bmp.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
        this.textureViews.push(tex.createView());
      } catch (e) {
        const tex = this.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        this.device.queue.writeTexture({ texture: tex }, new Uint8Array([110, 110, 110, 255]), {}, [1, 1]);
        this.textureViews.push(tex.createView());
      }
      onProgress?.((i + 1) / files.length);
    }
    this.texSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat'
    });
  }

  createPipelines() {
    const dev = this.device;
    const mainMod = dev.createShaderModule({ code: WGSL_SHADERS });
    const postMod = dev.createShaderModule({ code: WGSL_POST_SHADERS });

    // Frame Uniform Buffer (4 * mat4(256) + 8 * vec4(128) = 384 bytes -> 512 alinhado)
    this.uniformBuffer = dev.createBuffer({
      size: 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.shadowSampler = dev.createSampler({
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear'
    });

    this.linearSampler = dev.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });

    this.mainBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 16, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
      ]
    });

    // Bind group apenas com uniform para o Shadow Pass (evita conflito de uso do shadowMap)
    this.shadowBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }
      ]
    });
    this.shadowBindGroup = dev.createBindGroup({
      layout: this.shadowBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
    });

    const vertexLayout = {
      arrayStride: 12 * 4,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
        { shaderLocation: 2, offset: 6 * 4, format: 'float32x3' },
        { shaderLocation: 3, offset: 9 * 4, format: 'float32x2' },
        { shaderLocation: 4, offset: 11 * 4, format: 'float32' }
      ]
    };

    const instanceLayout = {
      arrayStride: 8 * 4,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 5, offset: 0, format: 'float32x4' },
        { shaderLocation: 6, offset: 4 * 4, format: 'float32x4' }
      ]
    };

    // --- SHADOW PIPELINES ---
    const shadowLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.shadowBindGroupLayout] });
    this.shadowTerrainPipeline = dev.createRenderPipeline({
      layout: shadowLayout,
      vertex: { module: mainMod, entryPoint: 'vsShadowTerrain', buffers: [vertexLayout] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
    });

    this.shadowInstancedPipeline = dev.createRenderPipeline({
      layout: shadowLayout,
      vertex: { module: mainMod, entryPoint: 'vsShadowInstanced', buffers: [vertexLayout, instanceLayout] },
      fragment: { module: mainMod, entryPoint: 'fsShadowClip', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
    });

    // --- HDR MAIN PIPELINES (Target: rgba16float) ---
    const mainLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.mainBindGroupLayout] });
    const hdrFormat = 'rgba16float';

    this.skyPipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mainMod, entryPoint: 'vsSky' },
      fragment: { module: mainMod, entryPoint: 'fsSky', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less-equal' }
    });

    this.terrainPipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mainMod, entryPoint: 'vsTerrain', buffers: [vertexLayout] },
      fragment: { module: mainMod, entryPoint: 'fsMain', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
    });

    this.solidInstancedPipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mainMod, entryPoint: 'vsInstanced', buffers: [vertexLayout, instanceLayout] },
      fragment: { module: mainMod, entryPoint: 'fsMain', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
    });

    this.foliageInstancedPipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mainMod, entryPoint: 'vsInstanced', buffers: [vertexLayout, instanceLayout] },
      fragment: { module: mainMod, entryPoint: 'fsMain', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
    });

    this.sporePipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: {
        module: mainMod,
        entryPoint: 'vsSpores',
        buffers: [{
          arrayStride: 16,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }]
        }]
      },
      fragment: {
        module: mainMod,
        entryPoint: 'fsSpores',
        targets: [{
          format: hdrFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' }
    });

    // Mãos em primeira pessoa (modo jogo): mesmos uniforms/fragmento da
    // cena, mas vértices no espaço do viewmodel transformados pela handsMat
    this.handsPipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mainMod, entryPoint: 'vsHands', buffers: [vertexLayout] },
      fragment: { module: mainMod, entryPoint: 'fsMain', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }
    });

    // Chuva: gotas geradas do índice da instância no vsRain — sem vertex buffer
    this.rainPipeline = dev.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mainMod, entryPoint: 'vsRain' },
      fragment: {
        module: mainMod,
        entryPoint: 'fsRain',
        targets: [{
          format: hdrFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' }
    });

    // --- POST-PROCESSING PIPELINES (Bloom Extract, Blur H/V, ACES Composite) ---
    this.postBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // Shadow map reutilizado pelo god-ray marcher do passe de composição
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } }
      ]
    });
    const postLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.postBindGroupLayout] });

    this.bloomExtractPipeline = dev.createRenderPipeline({
      layout: postLayout,
      vertex: { module: postMod, entryPoint: 'vsFullscreen' },
      fragment: { module: postMod, entryPoint: 'fsBloomExtract', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list' }
    });

    this.blurPipeline = dev.createRenderPipeline({
      layout: postLayout,
      vertex: { module: postMod, entryPoint: 'vsFullscreen' },
      fragment: { module: postMod, entryPoint: 'fsBlur', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list' }
    });

    this.compositePipeline = dev.createRenderPipeline({
      layout: postLayout,
      vertex: { module: postMod, entryPoint: 'vsFullscreen' },
      fragment: { module: postMod, entryPoint: 'fsComposite', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' }
    });

    this.postUniformH = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postUniformV = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.postUniformH, 0, new Float32Array([1.0, 0.0, 0.9, 0.5]));
    dev.queue.writeBuffer(this.postUniformV, 0, new Float32Array([0.0, 1.0, 0.9, 0.5]));

    this.rebuildShadowTexture(this.shadowRes);
  }

  rebuildShadowTexture(res) {
    this.shadowRes = res;
    if (this.shadowTexture) this.shadowTexture.destroy();
    this.shadowTexture = this.device.createTexture({
      size: [res, res],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.shadowView = this.shadowTexture.createView();
    // O passe de composição também amostra o shadow map (god rays):
    // os bind groups de pós precisam ser refeitos com a view nova
    if (this.bloomViewA) this.createPostBindGroups();
    this.mainBindGroup = this.device.createBindGroup({
      layout: this.mainBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: this.textureViews[0] },
        { binding: 4, resource: this.textureViews[1] },
        { binding: 5, resource: this.textureViews[2] },
        { binding: 6, resource: this.textureViews[3] },
        { binding: 8, resource: this.texSampler },
        { binding: 9, resource: this.textureViews[4] },
        { binding: 10, resource: this.textureViews[5] },
        { binding: 11, resource: this.textureViews[6] },
        { binding: 12, resource: this.textureViews[7] },
        { binding: 13, resource: this.textureViews[8] },
        { binding: 14, resource: this.textureViews[9] },
        { binding: 15, resource: this.textureViews[10] },
        { binding: 16, resource: this.textureViews[11] }
      ]
    });
  }

  createBuffer(data, usage) {
    const buf = this.device.createBuffer({
      size: Math.max(16, (data.byteLength + 3) & ~3),
      usage,
      mappedAtCreation: true
    });
    if (data instanceof Float32Array) new Float32Array(buf.getMappedRange()).set(data);
    else new Uint32Array(buf.getMappedRange()).set(data);
    buf.unmap();
    return buf;
  }

  uploadScene(meshes, instances, shadowRes) {
    if (shadowRes !== this.shadowRes) {
      this.rebuildShadowTexture(shadowRes);
    }
    if (this.sceneGpu) this.sceneGpu.forEach(b => b.destroy());
    this.sceneGpu = [];
    const buf = (data, usage) => {
      const b = this.createBuffer(data, usage);
      this.sceneGpu.push(b);
      return b;
    };
    this.sceneBuffers = {
      terrainVB: buf(meshes.terrain.vertices, GPUBufferUsage.VERTEX),
      terrainIB: buf(meshes.terrain.indices, GPUBufferUsage.INDEX),
      terrainIdxCount: meshes.terrain.indices.length,

      waterVB: buf(meshes.water.vertices, GPUBufferUsage.VERTEX),
      waterIB: buf(meshes.water.indices, GPUBufferUsage.INDEX),
      waterIdxCount: meshes.water.indices.length,

      sporeInstB: buf(instances.spores, GPUBufferUsage.VERTEX),
      sporeCount: instances.sporeCount,

      rainCount: instances.rainCount,

      handsVB: buf(meshes.hands.vertices, GPUBufferUsage.VERTEX),
      handsIB: buf(meshes.hands.indices, GPUBufferUsage.INDEX),
      handsIdxCount: meshes.hands.indices.length
    };

    // Camadas instanciadas: os buffers de instância chegam ordenados por
    // célula, com a faixa de cada célula em grid.starts
    const grid = instances.grid;
    const instBuffers = {};
    this.layers = INSTANCE_LAYERS.map(([meshName, listName, pipe, tier, shadow]) => {
      const m = meshes[meshName];
      if (!instBuffers[listName]) instBuffers[listName] = buf(instances[listName], GPUBufferUsage.VERTEX);
      return {
        vb: buf(m.vertices, GPUBufferUsage.VERTEX),
        ib: buf(m.indices, GPUBufferUsage.INDEX),
        idxCount: m.indices.length,
        instB: instBuffers[listName],
        starts: grid.starts[listName],
        pipe, tier, shadow
      };
    });
    this.grid = grid;
    // Faixas de células [início, fim) escolhidas a cada frame, por camada
    const cells = grid.n * grid.n;
    this.runs = {};
    this.runCount = {};
    for (const tier of ['near', 'mid', 'tree', 'far', 'under', 'all', 'shadow']) {
      this.runs[tier] = new Uint32Array(cells * 2);
      this.runCount[tier] = 0;
    }
    this.cellDist = new Float32Array(cells);
    this.nearCells = [];
    this.camPlanes = new Float32Array(16);
    this.sunPlanes = new Float32Array(24);
  }

  // Escolhe as células da grade a desenhar neste frame, a partir do próprio
  // uniform (viewProj, lightViewProj e posição da câmera): culling por
  // frustum da câmera e do sol + faixas de distância. É o que mantém o
  // custo do frame proporcional ao que se vê, não ao tamanho da floresta
  selectCells(u) {
    const g = this.grid, n = g.n, cs = g.cellSize, half = n * cs * 0.5;
    const runs = this.runs, count = this.runCount;
    for (const tier in count) count[tier] = 0;
    // Células vizinhas na ordem do buffer fundem-se numa faixa só
    const add = (tier, c) => {
      const r = runs[tier], k = count[tier];
      if (k > 0 && r[k * 2 - 1] === c) { r[k * 2 - 1] = c + 1; return; }
      r[k * 2] = c; r[k * 2 + 1] = c + 1;
      count[tier] = k + 1;
    };
    const camN = frustumPlanes(u, 0, this.camPlanes, false);
    const sunN = frustumPlanes(u, 32, this.sunPlanes, true);
    const camX = u[48], camY = u[49], camZ = u[50];
    const near = this.nearCells, dist = this.cellDist;
    near.length = 0;
    for (let c = 0; c < n * n; c++) {
      const r = g.radius[c];
      if (r <= 0) continue;
      const x = -half + ((c % n) + 0.5) * cs, z = -half + (Math.floor(c / n) + 0.5) * cs, y = g.centerY[c];
      if (sphereInPlanes(this.sunPlanes, sunN, x, y, z, r)) add('shadow', c);
      if (!sphereInPlanes(this.camPlanes, camN, x, y, z, r)) continue;
      add('all', c);
      const dx = x - camX, dy = y - camY, dz = z - camZ;
      dist[c] = Math.hypot(dx, dy, dz);
      if (dist[c] < g.lodDist) near.push(c); else add('far', c);
      // Sub-bosque: distância à borda da célula (cada instância ainda
      // encolhe até sumir no limite do alcance, no vertex shader)
      const ex = Math.max(Math.abs(dx) - cs * 0.5, 0), ez = Math.max(Math.abs(dz) - cs * 0.5, 0);
      if (Math.hypot(ex, ez) < g.understoryDist && Math.abs(dy) < g.understoryDist + r) add('under', c);
    }
    // Árvores próximas da frente para o fundo: o depth test barra as copas
    // escondidas antes do fragment shader (o mais caro da folhagem)
    near.sort((a, b) => dist[a] - dist[b]);
    for (const c of near) {
      add('tree', c);
      add(dist[c] < g.detailDist ? 'near' : 'mid', c);
    }
  }

  // Desenha as faixas de células de uma camada (draws instanciados com firstInstance)
  drawLayer(pass, layer, tier) {
    const runs = this.runs[tier], count = this.runCount[tier];
    let bound = false;
    for (let i = 0; i < count; i++) {
      const first = layer.starts[runs[i * 2]];
      const instCount = layer.starts[runs[i * 2 + 1]] - first;
      if (instCount <= 0) continue;
      if (!bound) {
        pass.setVertexBuffer(0, layer.vb);
        pass.setVertexBuffer(1, layer.instB);
        pass.setIndexBuffer(layer.ib, 'uint32');
        bound = true;
      }
      pass.drawIndexed(layer.idxCount, instCount, 0, 0, first);
    }
  }

  resize(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const bw = Math.max(1, Math.floor(w * 0.5));
    const bh = Math.max(1, Math.floor(h * 0.5));

    if (this.depthTexture) this.depthTexture.destroy();
    if (this.handsDepthTexture) this.handsDepthTexture.destroy();
    if (this.hdrTexture) this.hdrTexture.destroy();
    if (this.bloomTexA) this.bloomTexA.destroy();
    if (this.bloomTexB) this.bloomTexB.destroy();

    this.depthTexture = this.device.createTexture({
      size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    // Depth próprio das mãos (modo jogo): o passe limpa e escreve aqui —
    // o depth da cena segue intacto p/ god rays e SSAO do pós-processamento
    this.handsDepthTexture = this.device.createTexture({
      size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.hdrTexture = this.device.createTexture({
      size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTexA = this.device.createTexture({
      size: [bw, bh], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomTexB = this.device.createTexture({
      size: [bw, bh], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });

    this.depthView = this.depthTexture.createView();
    this.handsDepthView = this.handsDepthTexture.createView();
    this.hdrView = this.hdrTexture.createView();
    this.bloomViewA = this.bloomTexA.createView();
    this.bloomViewB = this.bloomTexB.createView();
    this.createPostBindGroups();
  }

  createPostBindGroups() {
    const postExtras = [
      { binding: 4, resource: this.depthView },
      { binding: 5, resource: { buffer: this.uniformBuffer } },
      { binding: 6, resource: this.shadowView },
      { binding: 7, resource: this.shadowSampler }
    ];
    this.bgExtract = this.device.createBindGroup({
      layout: this.postBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postUniformH } },
        { binding: 1, resource: this.hdrView },
        { binding: 2, resource: this.hdrView },
        { binding: 3, resource: this.linearSampler },
        ...postExtras
      ]
    });
    this.bgBlurH = this.device.createBindGroup({
      layout: this.postBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postUniformH } },
        { binding: 1, resource: this.bloomViewA },
        { binding: 2, resource: this.bloomViewA },
        { binding: 3, resource: this.linearSampler },
        ...postExtras
      ]
    });
    this.bgBlurV = this.device.createBindGroup({
      layout: this.postBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postUniformV } },
        { binding: 1, resource: this.bloomViewB },
        { binding: 2, resource: this.bloomViewB },
        { binding: 3, resource: this.linearSampler },
        ...postExtras
      ]
    });
    this.bgComposite = this.device.createBindGroup({
      layout: this.postBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postUniformH } },
        { binding: 1, resource: this.hdrView },
        { binding: 2, resource: this.bloomViewA },
        { binding: 3, resource: this.linearSampler },
        ...postExtras
      ]
    });
  }

  render(uniformData, clearColor, drawHands = false) {
    if (!this.depthTexture || !this.sceneBuffers) return;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    this.selectCells(uniformData);
    const sb = this.sceneBuffers;
    const encoder = this.device.createCommandEncoder();

    // 1. SHADOW MAP PASS (Sol projetando sombras das árvores, copas e rochas)
    const shadowPass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });
    shadowPass.setBindGroup(0, this.shadowBindGroup);
    shadowPass.setPipeline(this.shadowTerrainPipeline);
    shadowPass.setVertexBuffer(0, sb.terrainVB);
    shadowPass.setIndexBuffer(sb.terrainIB, 'uint32');
    shadowPass.drawIndexed(sb.terrainIdxCount, 1, 0, 0, 0);

    // Só as células que tocam o volume do shadow map
    shadowPass.setPipeline(this.shadowInstancedPipeline);
    for (const layer of this.layers) {
      if (layer.shadow) this.drawLayer(shadowPass, layer, 'shadow');
    }
    shadowPass.end();

    // 2. HDR SCENE PASS (rgba16float)
    const hdrPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.hdrView,
        clearValue: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });
    hdrPass.setBindGroup(0, this.mainBindGroup);

    // Terreno & Riacho
    hdrPass.setPipeline(this.terrainPipeline);
    hdrPass.setVertexBuffer(0, sb.terrainVB);
    hdrPass.setIndexBuffer(sb.terrainIB, 'uint32');
    hdrPass.drawIndexed(sb.terrainIdxCount, 1, 0, 0, 0);

    hdrPass.setVertexBuffer(0, sb.waterVB);
    hdrPass.setIndexBuffer(sb.waterIB, 'uint32');
    hdrPass.drawIndexed(sb.waterIdxCount, 1, 0, 0, 0);

    // Sólidos Instanciados
    hdrPass.setPipeline(this.solidInstancedPipeline);
    for (const layer of this.layers) {
      if (layer.pipe === 'solid') this.drawLayer(hdrPass, layer, layer.tier);
    }

    // Folhagem Dupla-Face Instanciada
    hdrPass.setPipeline(this.foliageInstancedPipeline);
    for (const layer of this.layers) {
      if (layer.pipe === 'foliage') this.drawLayer(hdrPass, layer, layer.tier);
    }

    // Céu por último entre os opacos: o depth test descarta os pixels já
    // cobertos por terreno/folhagem — o fsSky (raymarch de nuvens) é o
    // fragment shader mais caro do frame e antes rodava na tela inteira
    hdrPass.setPipeline(this.skyPipeline);
    hdrPass.draw(3, 1, 0, 0);

    // Esporos & Vagalumes
    if (sb.sporeCount > 0) {
      hdrPass.setPipeline(this.sporePipeline);
      hdrPass.setVertexBuffer(0, sb.sporeInstB);
      hdrPass.draw(6, sb.sporeCount, 0, 0);
    }

    // Chuva (u[59] carrega a intensidade; 0 = passe inteiro pulado)
    if (sb.rainCount > 0 && uniformData[59] > 0.004) {
      hdrPass.setPipeline(this.rainPipeline);
      hdrPass.draw(6, sb.rainCount, 0, 0);
    }
    hdrPass.end();

    // Mãos em primeira pessoa (modo jogo): passe à parte com depth limpo —
    // o viewmodel nunca afunda no cenário e entra no mesmo HDR do bloom
    if (drawHands && sb.handsIdxCount > 0) {
      const handsPass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.hdrView, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: this.handsDepthView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store'
        }
      });
      handsPass.setBindGroup(0, this.mainBindGroup);
      handsPass.setPipeline(this.handsPipeline);
      handsPass.setVertexBuffer(0, sb.handsVB);
      handsPass.setIndexBuffer(sb.handsIB, 'uint32');
      handsPass.drawIndexed(sb.handsIdxCount, 1, 0, 0, 0);
      handsPass.end();
    }

    // 3. POST-PROCESSING BLOOM + COMPOSITE
    const extractPass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.bloomViewA, loadOp: 'clear', storeOp: 'store' }]
    });
    extractPass.setPipeline(this.bloomExtractPipeline);
    extractPass.setBindGroup(0, this.bgExtract);
    extractPass.draw(3, 1, 0, 0);
    extractPass.end();

    const blurHPass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.bloomViewB, loadOp: 'clear', storeOp: 'store' }]
    });
    blurHPass.setPipeline(this.blurPipeline);
    blurHPass.setBindGroup(0, this.bgBlurH);
    blurHPass.draw(3, 1, 0, 0);
    blurHPass.end();

    const blurVPass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.bloomViewA, loadOp: 'clear', storeOp: 'store' }]
    });
    blurVPass.setPipeline(this.blurPipeline);
    blurVPass.setBindGroup(0, this.bgBlurV);
    blurVPass.draw(3, 1, 0, 0);
    blurVPass.end();

    const compPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    compPass.setPipeline(this.compositePipeline);
    compPass.setBindGroup(0, this.bgComposite);
    compPass.draw(3, 1, 0, 0);
    compPass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}


// ============================================================================
// EXPORTADOR ZIP MODULAR (Gera arquivo .zip sem dependências externas)
// ============================================================================
function downloadModularZip(modulesMap) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  const crc32 = (buf) => {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  const encoder = new TextEncoder();
  const files = [];
  for (const [name, content] of Object.entries(modulesMap)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    files.push({ name: encoder.encode(name), data, crc: crc32(data) });
  }

  let offset = 0;
  const parts = [];
  const centralDir = [];

  for (const f of files) {
    const localHeader = new Uint8Array(30 + f.name.length);
    const dv = new DataView(localHeader.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint32(14, f.crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, f.name.length, true);
    localHeader.set(f.name, 30);

    parts.push(localHeader, f.data);

    const cd = new Uint8Array(46 + f.name.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint32(16, f.crc, true);
    cdv.setUint32(20, f.data.length, true);
    cdv.setUint32(24, f.data.length, true);
    cdv.setUint16(28, f.name.length, true);
    cdv.setUint32(42, offset, true);
    cd.set(f.name, 46);
    centralDir.push(cd);

    offset += localHeader.length + f.data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdOffset, true);
  parts.push(eocd);

  const blob = new Blob(parts, { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'big-buck-country-webgpu.zip';
  a.click();
  URL.revokeObjectURL(url);
}

export class BigBuckApp {
  constructor(rawModulesSource) {
    this.rawModulesSource = rawModulesSource;
    this.canvas = document.getElementById('viewport');
    this.renderer = null;
    this.world = new ForestWorld(2026);
    this.audio = new ForestAudio();

    this.qualityKey = 'high';
    this.timeOfDay = 0.32;
    this.fogDensity = 0.55;
    this.windStrength = 0.65;
    this.rainIntensity = 0.0;
    this.camSpeed = 1.0;
    // Modo de câmera: 'livre' (anda/voa), 'passeio' (órbita auto), 'jogo'
    // (primeira pessoa no chão, com as mãos do jogador visíveis)
    this.camMode = 'livre';

    // Câmera inicia na margem da clareira olhando rio acima, para o maciço
    // (o ponto de partida vem da planta da ilha — world.spawn)
    this.cam = {
      pos: [this.world.spawn.cam[0], 2.2, this.world.spawn.cam[1]],
      yaw: this.world.spawn.yaw,
      pitch: 0.06,
      vel: [0, 0, 0],
      flying: false
    };

    this.keys = new Set();
    this.isDragging = false;
    this.lastMouse = [0, 0];
    this.uniformData = new Float32Array(96); // 384 bytes

    // Estado do modo jogo: pulo, e balanço/atraso das mãos (viewmodel)
    this.onGround = true;
    this.prevYaw = 0;
    this.prevPitch = 0;
    this.handSway = [0, 0];
    this.handBobPhase = 0;
    this.handBobAmt = 0;
    this.handRunAmt = 0;

    this.projMat = Mat4.create();
    this.viewMat = Mat4.create();
    this.vpMat = Mat4.create();
    this.handsMat = Mat4.create();
    this.invVpMat = Mat4.create();
    this.lightProj = Mat4.create();
    this.lightView = Mat4.create();
    this.lightVpMat = Mat4.create();

    this.lastFrameTime = performance.now();
    this.fpsFrames = 0;
    this.fpsTimer = 0;

    // Governador de FPS: escala a resolução interna sob carga para
    // sustentar >=30 FPS e devolve a resolução total quando a GPU folga
    this.renderScale = 1.0;
    this.upscaleStreak = 0;

    // Sequência do rebuild: trocas de qualidade/semente rápidas abortam
    // um rebuild anterior ainda em andamento (que cede frames ao overlay)
    this.rebuildSeq = 0;
  }

  // Alimenta a barra de carregamento do overlay de intro; vira no-op
  // quando o overlay já foi removido (rebuilds depois de entrar no mundo)
  setLoading(frac, label) {
    const bar = document.getElementById('load-bar');
    if (!bar) return;
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    bar.style.width = `${pct}%`;
    document.getElementById('load-pct').textContent = `${pct}%`;
    if (label) document.getElementById('backend-text-intro').textContent = label;
  }

  async bootstrap() {
    const preset = QUALITY_PRESETS[this.qualityKey];
    this.renderer = new WebGPURenderer(this.canvas);
    this.setLoading(0.02, 'Inicializando motor…');
    if (!(await this.renderer.init(preset.shadowRes, (f, label) => this.setLoading(0.02 + f * 0.48, label)))) {
      this.renderer = null;
      document.getElementById('backend-text-intro').textContent = 'WebGPU indisponível neste navegador — use Chrome, Edge ou Safari 18+';
      document.getElementById('api-pill').textContent = 'Sem WebGPU';
      document.getElementById('load-wrap').classList.add('hidden');
      document.getElementById('btn-enter').classList.remove('hidden');
      return;
    }

    document.getElementById('api-pill').textContent = this.renderer.api;

    await this.rebuildWorld();
    this.setLoading(1, 'Motor WebGPU HDR • Sombras & PBR Ativos');
    document.getElementById('btn-enter').classList.remove('hidden');
    this.handleResize();
    this.bindUI();

    this.cam.pos[1] = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]) + 2.0;
    requestAnimationFrame((t) => this.loop(t));
  }

  // Monta os meshes um por vez cedendo um frame entre eles, para a barra
  // de carregamento do overlay avançar em vez de travar num bloco síncrono
  async rebuildWorld() {
    const preset = QUALITY_PRESETS[this.qualityKey];
    const seq = ++this.rebuildSeq;
    const tick = () => new Promise(r => requestAnimationFrame(r));
    const steps = [
      ['terrain',    () => this.world.buildTerrainMesh(preset.terrainRes)],
      ['water',      () => this.world.buildWaterMesh(24)],
      ['trunkA',     () => this.world.buildTreeTrunkMesh(0)],
      ['trunkB',     () => this.world.buildTreeTrunkMesh(1)],
      ['trunkAFar',  () => this.world.buildTreeTrunkMesh(0, 1)],
      ['trunkBFar',  () => this.world.buildTreeTrunkMesh(1, 1)],
      ['canopyA',    () => this.world.buildCanopyClusterMesh(0)],
      ['canopyB',    () => this.world.buildCanopyClusterMesh(1)],
      ['canopyAMid', () => this.world.buildCanopyClusterMesh(0, 1)],
      ['canopyBMid', () => this.world.buildCanopyClusterMesh(1, 1)],
      ['canopyAFar', () => this.world.buildCanopyClusterMesh(0, 2)],
      ['canopyBFar', () => this.world.buildCanopyClusterMesh(1, 2)],
      ['trunkC',     () => this.world.buildTreeTrunkMesh(2)],
      ['trunkCFar',  () => this.world.buildTreeTrunkMesh(2, 1)],
      ['canopyC',    () => this.world.buildCanopyClusterMesh(2)],
      ['canopyCMid', () => this.world.buildCanopyClusterMesh(2, 1)],
      ['canopyCFar', () => this.world.buildCanopyClusterMesh(2, 2)],
      ['fern',       () => this.world.buildFernMesh()],
      ['grass',      () => this.world.buildGrassMesh()],
      ['bush',       () => this.world.buildBushMesh()],
      ['reed',       () => this.world.buildReedMesh()],
      ['broadleaf',  () => this.world.buildBroadleafMesh()],
      ['rock',       () => this.world.buildRockMesh()],
      ['log',        () => this.world.buildFallenLogMesh()],
      ['mushroom',   () => this.world.buildMushroomMesh()],
      ['hands',      () => this.world.buildHandsMesh()]
    ];
    this.setLoading(0.5, 'Construindo o mundo…');
    const meshes = {};
    for (let i = 0; i < steps.length; i++) {
      const [name, build] = steps[i];
      meshes[name] = build();
      this.setLoading(0.5 + 0.35 * (i + 1) / steps.length);
      await tick();
      if (seq !== this.rebuildSeq) return;
    }
    this.setLoading(0.88, 'Plantando a floresta…');
    await tick();
    if (seq !== this.rebuildSeq) return;
    const instances = this.world.generateInstances(preset);
    this.setLoading(0.96, 'Enviando para a GPU…');
    await tick();
    if (seq !== this.rebuildSeq) return;
    this.renderer.uploadScene(meshes, instances, preset.shadowRes);
    document.getElementById('val-instances').textContent = `${preset.label} (${instances.trunkACount + instances.trunkBCount + instances.trunkCCount} árvores)`;
    document.getElementById('seed-badge').textContent = `#${this.world.seed}`;
  }

  handleResize() {
    const preset = QUALITY_PRESETS[this.qualityKey];
    const w = Math.floor(window.innerWidth * preset.dpr * this.renderScale);
    const h = Math.floor(window.innerHeight * preset.dpr * this.renderScale);
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer.resize(w, h);
  }

  // Escala dinâmica de resolução: degrada e restaura suavemente mirando
  // >=30 FPS sem trocar o preset de qualidade escolhido pelo usuário
  autoScale(fps) {
    const MIN_SCALE = 0.5;
    if (fps < 29 && this.renderScale > MIN_SCALE) {
      this.renderScale = Math.max(MIN_SCALE, this.renderScale * 0.85);
      this.upscaleStreak = 0;
      this.handleResize();
    } else if (fps > 44 && this.renderScale < 1.0) {
      // Só restaura após janelas consecutivas de folga — evita oscilação
      if (++this.upscaleStreak >= 3) {
        this.upscaleStreak = 0;
        this.renderScale = Math.min(1.0, this.renderScale * 1.12);
        this.handleResize();
      }
    } else {
      this.upscaleStreak = 0;
    }
  }

  bindUI() {
    window.addEventListener('resize', () => this.handleResize());

    const intro = document.getElementById('intro-overlay');
    document.getElementById('btn-enter').addEventListener('click', () => {
      intro.classList.add('opacity-0', 'pointer-events-none');
      setTimeout(() => intro.remove(), 750);
    });

    // Download Projeto Modular (.zip)
    document.getElementById('btn-download-zip').addEventListener('click', async () => {
      const zipFiles = {
        'README.md': `# Big Buck Country — Ultra-Realistic WebGPU Procedural Forest\n\n## Estrutura\n- \`index.html\`: Interface HUD e ponto de entrada ES Module\n- \`src/math.js\`: PRNG determinístico, ruído FBM/Ridge e Mat4\n- \`src/quality.js\`: Presets de qualidade gráfica e shadow maps\n- \`src/island.js\`: Planta da ilha — contorno da costa, espinha do maciço central e rede de rios (compartilhada entre o relevo e o shader de água)\n- \`src/world.js\`: Gerador procedural da ilha — maciço central (cristas erodidas por fbm com derivada (fdlyW4 do iq), scree ocre, cumes nevados) cercado de floresta, rios que descem até o mar e praia em toda a volta\n- \`src/hands.js\`: Modelo das mãos em primeira pessoa (modo jogo) — 'WRAD ARMS' por wriks, CC0 1.0, gerado por tools/bake-maos.mjs\n- \`src/shaders.js\`: Shaders PBR Cook-Torrance GGX, Shadow Mapping PCF 3x3, céu atmosférico com nuvens procedurais, sombras de nuvens e estrelas, God Rays e Bloom HDR\n- \`src/audio.js\`: Sintetizador Web Audio procedural\n- \`src/main.js\`: Orquestrador de renderização WebGPU\n- \`textures/\`: Texturas do pacote de mídia do Shadertoy (CC BY-NC-SA 3.0)\n\n## Como Executar\nSirva a pasta com qualquer servidor HTTP local (ex: \`npx serve .\` ou \`python -m http.server\`).`,
        'index.html': this.rawModulesSource['index.html'],
        'src/math.js': this.rawModulesSource['math.js'],
        'src/quality.js': this.rawModulesSource['quality.js'],
        'src/island.js': this.rawModulesSource['island.js'],
        'src/world.js': this.rawModulesSource['world.js'],
        'src/hands.js': this.rawModulesSource['hands.js'],
        'src/shaders.js': this.rawModulesSource['shaders.js'],
        'src/audio.js': this.rawModulesSource['audio.js'],
        'src/main.js': this.rawModulesSource['main.js']
      };
      // Inclui as texturas fotográficas (pacote de mídia do Shadertoy, CC BY-NC-SA)
      for (const t of ['textures/bark.jpg', 'textures/rock.jpg', 'textures/pebbles.png', 'textures/noise.png',
                       'textures/litter.jpg', 'textures/wetstones.jpg', 'textures/twigs.jpg', 'textures/bark2.jpg',
                       'textures/granite.jpg', 'textures/graynoise.png', 'textures/wood.jpg', 'textures/sand.png']) {
        try { zipFiles[t] = new Uint8Array(await (await fetch(t)).arrayBuffer()); } catch (e) { /* servidor sem a pasta textures */ }
      }
      downloadModularZip(zipFiles);
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        if (this.camMode === 'passeio') this.setCamMode('livre');
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    this.canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== this.canvas && window.innerWidth > 768) {
        this.canvas.requestPointerLock?.();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.cam.yaw -= e.movementX * 0.0022;
        this.cam.pitch = Math.max(-1.42, Math.min(1.42, this.cam.pitch - e.movementY * 0.0022));
        if (this.camMode === 'passeio') this.setCamMode('livre');
      } else if (this.isDragging) {
        const dx = e.clientX - this.lastMouse[0];
        const dy = e.clientY - this.lastMouse[1];
        this.lastMouse = [e.clientX, e.clientY];
        this.cam.yaw -= dx * 0.004;
        this.cam.pitch = Math.max(-1.42, Math.min(1.42, this.cam.pitch - dy * 0.004));
        if (this.camMode === 'passeio') this.setCamMode('livre');
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.lastMouse = [e.clientX, e.clientY];
    });
    window.addEventListener('mouseup', () => { this.isDragging = false; });

    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
      }
    }, { passive: true });
    this.canvas.addEventListener('touchmove', (e) => {
      if (this.isDragging && e.touches.length === 1) {
        const dx = e.touches[0].clientX - this.lastMouse[0];
        const dy = e.touches[0].clientY - this.lastMouse[1];
        this.lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
        this.cam.yaw -= dx * 0.005;
        this.cam.pitch = Math.max(-1.42, Math.min(1.42, this.cam.pitch - dy * 0.005));
        if (this.camMode === 'passeio') this.setCamMode('livre');
      }
    }, { passive: true });
    this.canvas.addEventListener('touchend', () => { this.isDragging = false; });

    const bindTouchBtn = (id, code) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => { e.preventDefault(); this.keys.add(code); });
      el.addEventListener('touchend', (e) => { e.preventDefault(); this.keys.delete(code); });
    };
    bindTouchBtn('touch-fwd', 'KeyW');
    bindTouchBtn('touch-bwd', 'KeyS');

    const timeSlider = document.getElementById('slider-time');
    const timeLabel = document.getElementById('val-time');
    const updateTimeLabel = (v) => {
      const totalMins = Math.floor(v * 24 * 60);
      const hh = String(Math.floor(totalMins / 60) % 24).padStart(2, '0');
      const mm = String(totalMins % 60).padStart(2, '0');
      let period = 'Zênite Esmeralda';
      if (v < 0.20) period = 'Noite Bioluminescente';
      else if (v < 0.29) period = 'Alvorecer';
      else if (v < 0.46) period = 'Manhã Dourada';
      else if (v < 0.71) period = 'Zênite Esmeralda';
      else if (v < 0.79) period = 'Crepúsculo';
      else period = 'Noite Bioluminescente';
      timeLabel.textContent = `${hh}:${mm} (${period})`;
    };
    timeSlider.addEventListener('input', (e) => {
      this.timeOfDay = parseFloat(e.target.value);
      updateTimeLabel(this.timeOfDay);
    });
    updateTimeLabel(this.timeOfDay);

    document.getElementById('slider-fog').addEventListener('input', (e) => {
      this.fogDensity = parseFloat(e.target.value);
      document.getElementById('val-fog').textContent = `${Math.round(this.fogDensity * 100)}%`;
    });

    document.getElementById('slider-rain').addEventListener('input', (e) => {
      this.rainIntensity = parseFloat(e.target.value);
      document.getElementById('val-rain').textContent = `${Math.round(this.rainIntensity * 100)}%`;
    });

    document.getElementById('slider-wind').addEventListener('input', (e) => {
      this.windStrength = parseFloat(e.target.value);
      document.getElementById('val-wind').textContent = `${Math.round((this.windStrength / 1.5) * 100)}%`;
    });

    document.getElementById('slider-speed').addEventListener('input', (e) => {
      this.camSpeed = parseFloat(e.target.value);
      document.getElementById('val-speed').textContent = `${this.camSpeed.toFixed(2)}×`;
    });

    document.querySelectorAll('.q-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.q-btn').forEach(b => {
          b.className = 'q-btn py-1.5 rounded-lg text-xs font-medium text-emerald-100/70 hover:text-white transition cursor-pointer';
        });
        btn.className = 'q-btn py-1.5 rounded-lg text-xs font-medium bg-emerald-500/30 text-emerald-200 border border-emerald-400/30 transition cursor-pointer';
        this.qualityKey = btn.dataset.quality;
        this.handleResize();
        this.rebuildWorld();
      });
    });

    document.getElementById('btn-regen').addEventListener('click', () => {
      this.world = new ForestWorld(Math.floor(Math.random() * 999999));
      this.rebuildWorld();
      this.cam.pos[1] = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]) + 2.0;
    });

    document.getElementById('btn-audio').addEventListener('click', () => {
      const active = this.audio.toggle();
      document.getElementById('icon-audio-off').classList.toggle('hidden', active);
      document.getElementById('icon-audio-on').classList.toggle('hidden', !active);
      document.getElementById('audio-label').textContent = active ? 'Som: On' : 'Som: Off';
    });

    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setCamMode(btn.dataset.mode));
    });

    const panel = document.getElementById('controls-panel');
    document.getElementById('btn-toggle-hud').addEventListener('click', () => {
      panel.classList.toggle('opacity-0');
      panel.classList.toggle('pointer-events-none');
      panel.classList.toggle('translate-y-4');
    });
  }

  // Troca o modo de câmera e o estado visual dos botões do seletor
  setCamMode(mode) {
    this.camMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      const active = b.dataset.mode === mode;
      b.className = `mode-btn py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${active
        ? 'bg-emerald-500/30 text-emerald-200 border border-emerald-400/30'
        : 'text-emerald-100/70 hover:text-white'}`;
    });
    const crosshair = document.getElementById('crosshair');
    if (crosshair) crosshair.classList.toggle('hidden', mode !== 'jogo');
    if (mode === 'jogo') {
      // Primeira pessoa: cola no chão e pede o mouse (o clique do botão é o gesto)
      this.cam.flying = false;
      this.cam.vel[1] = 0;
      this.onGround = true;
      const g = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]);
      this.cam.pos[1] = Math.max(g, -2.1) + 1.72;
      const lock = this.canvas.requestPointerLock?.();
      if (lock?.catch) lock.catch(() => {});
    }
  }

  // Compatibilidade com o script de captura (bbc-captura)
  setAutoTour(enabled) {
    this.setCamMode(enabled ? 'passeio' : 'livre');
  }

  updateCamera(dt, elapsedSec) {
    if (this.camMode === 'passeio') {
      const angle = elapsedSec * 0.075;
      const radius = 30.0 + Math.sin(elapsedSec * 0.14) * 12.0;
      // O passeio orbita a clareira de partida
      this.cam.pos[0] = this.world.focus[0] + Math.cos(angle) * radius;
      this.cam.pos[2] = this.world.focus[1] + Math.sin(angle) * radius;
      const groundY = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]);
      this.cam.pos[1] = groundY + 3.0 + Math.sin(elapsedSec * 0.35) * 0.85;
      this.cam.yaw = -angle - Math.PI * 0.5 + Math.sin(elapsedSec * 0.22) * 0.35;
      this.cam.pitch = 0.05 + Math.sin(elapsedSec * 0.28) * 0.07;
      return;
    }

    const game = this.camMode === 'jogo';
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = (run ? (game ? 11.0 : 22.0) : (game ? 5.6 : 8.0)) * this.camSpeed;
    const forwardX = Math.sin(this.cam.yaw);
    const forwardZ = Math.cos(this.cam.yaw);
    const rightX = Math.cos(this.cam.yaw);
    const rightZ = -Math.sin(this.cam.yaw);

    let moveX = 0, moveZ = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { moveX += forwardX; moveZ += forwardZ; }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { moveX -= forwardX; moveZ -= forwardZ; }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { moveX += rightX; moveZ += rightZ; }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { moveX -= rightX; moveZ -= rightZ; }

    const len = Math.hypot(moveX, moveZ);
    if (len > 0) {
      moveX = (moveX / len) * speed;
      moveZ = (moveZ / len) * speed;
    }

    const damping = 1.0 - Math.exp(-dt * 10.0);
    this.cam.vel[0] += (moveX - this.cam.vel[0]) * damping;
    this.cam.vel[2] += (moveZ - this.cam.vel[2]) * damping;

    // Permite sair da ilha e flutuar sobre o mar um trecho além da costa
    const limit = this.world.worldSize * 0.75;
    this.cam.pos[0] = Math.max(-limit, Math.min(limit, this.cam.pos[0] + this.cam.vel[0] * dt));
    this.cam.pos[2] = Math.max(-limit, Math.min(limit, this.cam.pos[2] + this.cam.vel[2] * dt));

    if (!game && (this.keys.has('Space') || this.keys.has('KeyC'))) this.cam.flying = true;

    const groundY = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]);
    if (this.cam.flying) {
      // Voo livre: Espaço sobe, C desce — a altura não segue mais o relevo
      let moveY = 0;
      if (this.keys.has('Space')) moveY += speed * 1.75;
      if (this.keys.has('KeyC')) moveY -= speed * 1.75;
      this.cam.vel[1] += (moveY - this.cam.vel[1]) * damping;
      this.cam.pos[1] = Math.min(600.0, this.cam.pos[1] + this.cam.vel[1] * dt);
      // Não atravessa o relevo nem o fundo do mar
      const minY = groundY + 0.6;
      if (this.cam.pos[1] < minY) { this.cam.pos[1] = minY; this.cam.vel[1] = 0; }
      // Pousa ao descer até a altura de caminhada em terra firme ou água rasa
      if (moveY <= 0 && groundY > -2.1 && this.cam.pos[1] <= groundY + 1.85) {
        this.cam.flying = false;
        this.cam.vel[1] = 0;
      }
    } else if (game) {
      // Modo jogo: primeira pessoa no chão — Espaço pula e a gravidade
      // derruba de volta (inclusive ao sair correndo de um barranco)
      const floorY = Math.max(groundY, -2.1) + 1.72;
      if (this.cam.pos[1] > floorY + 0.08) this.onGround = false;
      if (this.onGround) {
        if (this.keys.has('Space')) { this.cam.vel[1] = 4.9; this.onGround = false; }
        const bob = len > 0.1 ? Math.sin(elapsedSec * 10.5) * 0.05 : 0;
        this.cam.pos[1] += (floorY + bob - this.cam.pos[1]) * damping;
      } else {
        this.cam.vel[1] -= 13.5 * dt;
        this.cam.pos[1] += this.cam.vel[1] * dt;
        if (this.cam.pos[1] <= floorY) {
          this.cam.pos[1] = floorY;
          this.cam.vel[1] = 0;
          this.onGround = true;
        }
      }
    } else {
      const bob = len > 0.1 ? Math.sin(elapsedSec * 9.5) * 0.055 : 0;
      const targetY = Math.max(groundY, -2.1) + 1.85 + bob;
      this.cam.pos[1] += (targetY - this.cam.pos[1]) * damping;
    }

    // Mãos do modo jogo: atraso de swing no olhar + balanço do passo
    const dYaw = this.cam.yaw - this.prevYaw;
    const dPitch = this.cam.pitch - this.prevPitch;
    this.prevYaw = this.cam.yaw;
    this.prevPitch = this.cam.pitch;
    const swayK = Math.min(1, dt * 8.0);
    this.handSway[0] += (dYaw * 9.0 - this.handSway[0]) * swayK;
    this.handSway[1] += (-dPitch * 9.0 - this.handSway[1]) * swayK;
    const hv = Math.hypot(this.cam.vel[0], this.cam.vel[2]);
    this.handBobPhase += hv * dt * 1.7;
    this.handBobAmt += ((game && hv > 0.4 ? Math.min(1, hv / 6.0) : 0) - this.handBobAmt) * Math.min(1, dt * 7.0);
    // Corrida levanta o viewmodel: o toco do antebraço aparece no balanço
    this.handRunAmt += ((game && hv > 7.0 ? 1 : 0) - this.handRunAmt) * Math.min(1, dt * 6.0);
  }

  // Coordenadas da ilha: origem no centro, lng = x (leste+), lat = -z (norte+),
  // em metros. Direção: yaw 0 = sul, bearing = 180 - yaw em graus.
  updateCoordsPill() {
    const winds = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
    const bearing = ((180 - this.cam.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const wind = winds[Math.round(bearing / 45) % 8];
    const lat = this.cam.pos[2] * -1, lng = this.cam.pos[0];
    const latTxt = `${Math.abs(Math.round(lat))} m ${lat >= 0 ? 'N' : 'S'}`;
    const lngTxt = `${Math.abs(Math.round(lng))} m ${lng >= 0 ? 'L' : 'O'}`;
    document.getElementById('coords-pill').textContent =
      `${wind} ${String(Math.round(bearing)).padStart(3, '0')}° · lat ${latTxt} · lng ${lngTxt}`;
  }

  computeAtmosphere() {
    // Ciclo de 24h: ângulo 0 = nascer (leste) às 6h (t=0.25), zênite ao
    // meio-dia (t=0.5), poente (oeste) às 18h (t=0.75), meia-noite em t=0/1
    const sunAngle = (this.timeOfDay - 0.25) * Math.PI * 2.0;
    // Elevação com sinal: negativo = sol abaixo do horizonte (noite)
    const elevation = Math.sin(sunAngle);
    // Arco leste→oeste: nasce a leste (+x, ângulo 0), culmina inclinado ao
    // sul (+z) e põe-se a oeste (-x, ângulo π). Fora de [0, π] o sol está
    // abaixo do horizonte — é a noite.
    const sunDir = [
      Math.cos(sunAngle),
      Math.sin(sunAngle) * 0.9075,
      Math.sin(sunAngle) * 0.42
    ];
    // Lua com a mesma regra, meio ciclo atrasada: nasce a leste quando o
    // sol se põe a oeste e culmina à meia-noite
    const moonDir = [-sunDir[0], -sunDir[1], -sunDir[2]];
    // Fonte de luz efetiva (iluminação + shadow map): sol até o crepúsculo
    // profundo; abaixo de -0.05 de elevação a lua assume
    const moonUp = elevation < -0.05;
    const lightDir = moonUp ? moonDir.slice() : sunDir.slice();
    lightDir[1] = Math.max(0.015, lightDir[1]);

    const dayFactor = Math.max(0, Math.min(1, elevation * 1.45 + 0.15));
    const goldenFactor = Math.exp(-Math.pow((elevation - 0.18) / 0.24, 2.0));

    const sunColor = [
      0.16 + dayFactor * 0.95 + goldenFactor * 0.55,
      0.24 + dayFactor * 0.82 + goldenFactor * 0.18,
      0.38 + dayFactor * 0.55 - goldenFactor * 0.15
    ];

    const skyTop = [
      0.02 + dayFactor * 0.08,
      0.05 + dayFactor * 0.26,
      0.09 + dayFactor * 0.40
    ];

    const skyHorizon = [
      0.04 + dayFactor * 0.24 + goldenFactor * 0.38,
      0.09 + dayFactor * 0.38 + goldenFactor * 0.22,
      0.11 + dayFactor * 0.28
    ];

    const fogColor = [
      0.03 + dayFactor * 0.20 + goldenFactor * 0.22,
      0.07 + dayFactor * 0.25 + goldenFactor * 0.12,
      0.08 + dayFactor * 0.19
    ];

    // Céu fechado: a chuva mistura a paleta para cinza-chumbo — o sol apaga,
    // o horizonte fica mais claro que o zênite e a névoa acinzenta
    const rain = this.rainIntensity;
    if (rain > 0.001) {
      const mix3 = (a, b) => [a[0] + (b[0] - a[0]) * rain, a[1] + (b[1] - a[1]) * rain, a[2] + (b[2] - a[2]) * rain];
      sunColor.splice(0, 3, ...mix3(sunColor, [0.20 + dayFactor * 0.28, 0.23 + dayFactor * 0.30, 0.27 + dayFactor * 0.33]));
      skyTop.splice(0, 3, ...mix3(skyTop, [0.030 + dayFactor * 0.045, 0.038 + dayFactor * 0.055, 0.048 + dayFactor * 0.065]));
      skyHorizon.splice(0, 3, ...mix3(skyHorizon, [0.09 + dayFactor * 0.12, 0.10 + dayFactor * 0.13, 0.11 + dayFactor * 0.14]));
      fogColor.splice(0, 3, ...mix3(fogColor, [0.08 + dayFactor * 0.10, 0.09 + dayFactor * 0.11, 0.10 + dayFactor * 0.12]));
    }

    return { sunDir, moonDir, lightDir, sunColor, skyTop, skyHorizon, fogColor, elevation };
  }

  invertMat4(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return out;
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    const elapsedSec = now / 1000;

    this.fpsFrames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      const fps = Math.round(this.fpsFrames / this.fpsTimer);
      const pct = this.renderScale < 1.0 ? ` · ${Math.round(this.renderScale * 100)}%` : '';
      document.getElementById('fps-counter').textContent = `${fps} FPS${pct}`;
      this.updateCoordsPill();
      this.fpsFrames = 0;
      this.fpsTimer = 0;
      this.autoScale(fps);
    }

    this.updateCamera(dt, elapsedSec);

    this.audio.update(this.windStrength, this.world.riverDist(this.cam.pos[0], this.cam.pos[2]), elapsedSec, this.rainIntensity);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    Mat4.perspective(this.projMat, (60 * Math.PI) / 180, aspect, 0.2,
      Math.max(this.world.worldSize * 1.7, this.world.oceanSize * 0.75));

    const lookDir = [
      Math.sin(this.cam.yaw) * Math.cos(this.cam.pitch),
      Math.sin(this.cam.pitch),
      Math.cos(this.cam.yaw) * Math.cos(this.cam.pitch)
    ];
    const target = [
      this.cam.pos[0] + lookDir[0],
      this.cam.pos[1] + lookDir[1],
      this.cam.pos[2] + lookDir[2]
    ];
    Mat4.lookAt(this.viewMat, this.cam.pos, target, [0, 1, 0]);
    Mat4.multiply(this.vpMat, this.projMat, this.viewMat);
    this.invertMat4(this.invVpMat, this.vpMat);

    // Matriz das mãos do modo jogo: colunas = direita/cima/frente da tela
    // (a base mira-para-trás do lookAt) e origem nos olhos — mais o atraso
    // do olhar (sway) e o balanço do passo, o típico flutuar de viewmodel
    const scrRightX = -Math.cos(this.cam.yaw), scrRightZ = Math.sin(this.cam.yaw);
    const scrUp = [
      -scrRightZ * lookDir[1],
      scrRightZ * lookDir[0] - scrRightX * lookDir[2],
      scrRightX * lookDir[1]
    ];
    const handOX = this.handSway[0] * 0.06 + Math.sin(this.handBobPhase) * 0.014 * this.handBobAmt;
    const handOY = this.handSway[1] * 0.05 - Math.abs(Math.cos(this.handBobPhase)) * 0.011 * this.handBobAmt - this.handBobAmt * 0.004 + this.handRunAmt * 0.09;
    const handOZ = -0.02 * this.handBobAmt - this.handRunAmt * 0.05;
    const hm = this.handsMat;
    hm[0] = scrRightX;   hm[1] = 0;          hm[2] = scrRightZ;   hm[3] = 0;
    hm[4] = scrUp[0];    hm[5] = scrUp[1];   hm[6] = scrUp[2];    hm[7] = 0;
    hm[8] = lookDir[0];  hm[9] = lookDir[1]; hm[10] = lookDir[2]; hm[11] = 0;
    hm[12] = this.cam.pos[0] + scrRightX * handOX + scrUp[0] * handOY + lookDir[0] * handOZ;
    hm[13] = this.cam.pos[1] + scrUp[1] * handOY + lookDir[1] * handOZ;
    hm[14] = this.cam.pos[2] + scrRightZ * handOX + scrUp[2] * handOY + lookDir[2] * handOZ;
    hm[15] = 1;

    const atm = this.computeAtmosphere();

    // Matriz de Sombra Ortográfica centrada ao redor da câmera
    const shadowExtent = 68.0;
    const lightEye = [
      this.cam.pos[0] + atm.lightDir[0] * 85.0,
      atm.lightDir[1] * 85.0,
      this.cam.pos[2] + atm.lightDir[2] * 85.0
    ];
    const lightTarget = [this.cam.pos[0], 0.0, this.cam.pos[2]];
    Mat4.lookAt(this.lightView, lightEye, lightTarget, [0, 1, 0]);
    Mat4.ortho(this.lightProj, -shadowExtent, shadowExtent, -shadowExtent, shadowExtent, 5.0, 190.0);
    Mat4.multiply(this.lightVpMat, this.lightProj, this.lightView);

    const preset = QUALITY_PRESETS[this.qualityKey];
    const u = this.uniformData;
    u.set(this.vpMat, 0);
    u.set(this.invVpMat, 16);
    u.set(this.lightVpMat, 32);
    u.set(this.handsMat, 80);

    u[48] = this.cam.pos[0]; u[49] = this.cam.pos[1]; u[50] = this.cam.pos[2]; u[51] = this.world.seed; // .w: seed p/ hash do leito no shader de água
    u[52] = atm.sunDir[0];   u[53] = atm.sunDir[1];   u[54] = atm.sunDir[2];   u[55] = preset.understoryDist; // .w: alcance do sub-bosque (fade no vsInstanced)
    u[56] = atm.sunColor[0]; u[57] = atm.sunColor[1]; u[58] = atm.sunColor[2]; u[59] = this.rainIntensity; // .w: intensidade da chuva
    u[60] = atm.skyTop[0];   u[61] = atm.skyTop[1];   u[62] = atm.skyTop[2];   u[63] = atm.moonDir[0]; // .w: lua.x
    u[64] = atm.skyHorizon[0]; u[65] = atm.skyHorizon[1]; u[66] = atm.skyHorizon[2]; u[67] = atm.moonDir[1]; // .w: lua.y
    u[68] = atm.fogColor[0]; u[69] = atm.fogColor[1]; u[70] = atm.fogColor[2]; u[71] = atm.moonDir[2]; // .w: lua.z

    u[72] = elapsedSec;
    u[73] = this.windStrength;
    u[74] = this.fogDensity + this.rainIntensity * 0.35; // a chuva engrossa a névoa
    u[75] = atm.elevation;

    u[76] = preset.godRaySteps;
    u[77] = 1.05;
    u[78] = 0.0028;
    u[79] = aspect;

    this.renderer.render(u, atm.skyHorizon, this.camMode === 'jogo');
    requestAnimationFrame((t) => this.loop(t));
  }
}