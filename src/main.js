// ============================================================================
// main.js — Orquestrador WebGPU (Shadow Map + HDR + Bloom + God Rays),
// Controles e Exportador ZIP Modular
// ============================================================================

import { Mat4 } from './math.js';
import { QUALITY_PRESETS } from './quality.js';
import { ForestWorld } from './world.js';
import { WGSL_SHADERS, WGSL_POST_SHADERS } from './shaders.js';
import { ForestAudio } from './audio.js';

class WebGPURenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.api = 'WebGPU HDR';
    this.device = null;
    this.context = null;
    this.format = null;
    this.shadowRes = 2048;
  }

  async init(shadowRes = 2048) {
    if (!navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return false;
      this.device = await adapter.requestDevice();
      this.context = this.canvas.getContext('webgpu');
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque'
      });
      this.shadowRes = shadowRes;
      await this.loadTextures();
      this.createPipelines();
      return true;
    } catch (e) {
      console.warn('WebGPU indisponível:', e);
      return false;
    }
  }

  async loadTextures() {
    // Texturas fotográficas do pacote de mídia do Shadertoy (espelhadas localmente)
    const files = [
      'textures/bark.jpg', 'textures/rock.jpg', 'textures/pebbles.png', 'textures/noise.png', 'textures/stars.jpg',
      'textures/litter.jpg', 'textures/wetstones.jpg', 'textures/twigs.jpg', 'textures/bark2.jpg',
      'textures/granite.jpg', 'textures/graynoise.png', 'textures/wood.jpg'
    ];
    this.textureViews = [];
    for (const f of files) {
      try {
        const bmp = await createImageBitmap(await (await fetch(f)).blob(), { colorSpaceConversion: 'none' });
        const tex = this.device.createTexture({
          size: [bmp.width, bmp.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        this.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
        this.textureViews.push(tex.createView());
      } catch (e) {
        const tex = this.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        this.device.queue.writeTexture({ texture: tex }, new Uint8Array([110, 110, 110, 255]), {}, [1, 1]);
        this.textureViews.push(tex.createView());
      }
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

    // Frame Uniform Buffer (3 * mat4(192) + 8 * vec4(128) = 320 bytes -> 512 alinhado)
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
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
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

    // --- POST-PROCESSING PIPELINES (Bloom Extract, Blur H/V, ACES Composite) ---
    this.postBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
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
    dev.queue.writeBuffer(this.postUniformH, 0, new Float32Array([1.0, 0.0, 1.05, 0.42]));
    dev.queue.writeBuffer(this.postUniformV, 0, new Float32Array([0.0, 1.0, 1.05, 0.42]));

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
        { binding: 7, resource: this.textureViews[4] },
        { binding: 8, resource: this.texSampler },
        { binding: 9, resource: this.textureViews[5] },
        { binding: 10, resource: this.textureViews[6] },
        { binding: 11, resource: this.textureViews[7] },
        { binding: 12, resource: this.textureViews[8] },
        { binding: 13, resource: this.textureViews[9] },
        { binding: 14, resource: this.textureViews[10] },
        { binding: 15, resource: this.textureViews[11] }
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
    if (this.sceneBuffers) {
      Object.values(this.sceneBuffers).forEach(b => b && b.destroy && b.destroy());
    }
    this.sceneBuffers = {
      terrainVB: this.createBuffer(meshes.terrain.vertices, GPUBufferUsage.VERTEX),
      terrainIB: this.createBuffer(meshes.terrain.indices, GPUBufferUsage.INDEX),
      terrainIdxCount: meshes.terrain.indices.length,

      waterVB: this.createBuffer(meshes.water.vertices, GPUBufferUsage.VERTEX),
      waterIB: this.createBuffer(meshes.water.indices, GPUBufferUsage.INDEX),
      waterIdxCount: meshes.water.indices.length,

      trunkAVB: this.createBuffer(meshes.trunkA.vertices, GPUBufferUsage.VERTEX),
      trunkAIB: this.createBuffer(meshes.trunkA.indices, GPUBufferUsage.INDEX),
      trunkAIdxCount: meshes.trunkA.indices.length,
      trunkAInstB: this.createBuffer(instances.trunksA, GPUBufferUsage.VERTEX),
      trunkAInstCount: instances.trunkACount,

      trunkBVB: this.createBuffer(meshes.trunkB.vertices, GPUBufferUsage.VERTEX),
      trunkBIB: this.createBuffer(meshes.trunkB.indices, GPUBufferUsage.INDEX),
      trunkBIdxCount: meshes.trunkB.indices.length,
      trunkBInstB: this.createBuffer(instances.trunksB, GPUBufferUsage.VERTEX),
      trunkBInstCount: instances.trunkBCount,

      canopyAVB: this.createBuffer(meshes.canopyA.vertices, GPUBufferUsage.VERTEX),
      canopyAIB: this.createBuffer(meshes.canopyA.indices, GPUBufferUsage.INDEX),
      canopyAIdxCount: meshes.canopyA.indices.length,
      canopyAInstB: this.createBuffer(instances.canopiesA, GPUBufferUsage.VERTEX),
      canopyAInstCount: instances.canopyACount,

      canopyBVB: this.createBuffer(meshes.canopyB.vertices, GPUBufferUsage.VERTEX),
      canopyBIB: this.createBuffer(meshes.canopyB.indices, GPUBufferUsage.INDEX),
      canopyBIdxCount: meshes.canopyB.indices.length,
      canopyBInstB: this.createBuffer(instances.canopiesB, GPUBufferUsage.VERTEX),
      canopyBInstCount: instances.canopyBCount,

      fernVB: this.createBuffer(meshes.fern.vertices, GPUBufferUsage.VERTEX),
      fernIB: this.createBuffer(meshes.fern.indices, GPUBufferUsage.INDEX),
      fernIdxCount: meshes.fern.indices.length,
      fernInstB: this.createBuffer(instances.ferns, GPUBufferUsage.VERTEX),
      fernInstCount: instances.fernCount,

      grassVB: this.createBuffer(meshes.grass.vertices, GPUBufferUsage.VERTEX),
      grassIB: this.createBuffer(meshes.grass.indices, GPUBufferUsage.INDEX),
      grassIdxCount: meshes.grass.indices.length,
      grassInstB: this.createBuffer(instances.grasses, GPUBufferUsage.VERTEX),
      grassInstCount: instances.grassCount,

      rockVB: this.createBuffer(meshes.rock.vertices, GPUBufferUsage.VERTEX),
      rockIB: this.createBuffer(meshes.rock.indices, GPUBufferUsage.INDEX),
      rockIdxCount: meshes.rock.indices.length,
      rockInstB: this.createBuffer(instances.rocks, GPUBufferUsage.VERTEX),
      rockInstCount: instances.rockCount,

      logVB: this.createBuffer(meshes.log.vertices, GPUBufferUsage.VERTEX),
      logIB: this.createBuffer(meshes.log.indices, GPUBufferUsage.INDEX),
      logIdxCount: meshes.log.indices.length,
      logInstB: this.createBuffer(instances.logs, GPUBufferUsage.VERTEX),
      logInstCount: instances.logCount,

      mushVB: this.createBuffer(meshes.mushroom.vertices, GPUBufferUsage.VERTEX),
      mushIB: this.createBuffer(meshes.mushroom.indices, GPUBufferUsage.INDEX),
      mushIdxCount: meshes.mushroom.indices.length,
      mushInstB: this.createBuffer(instances.mushrooms, GPUBufferUsage.VERTEX),
      mushInstCount: instances.mushroomCount,

      sporeInstB: this.createBuffer(instances.spores, GPUBufferUsage.VERTEX),
      sporeCount: instances.sporeCount
    };
  }

  resize(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const bw = Math.max(1, Math.floor(w * 0.5));
    const bh = Math.max(1, Math.floor(h * 0.5));

    if (this.depthTexture) this.depthTexture.destroy();
    if (this.hdrTexture) this.hdrTexture.destroy();
    if (this.bloomTexA) this.bloomTexA.destroy();
    if (this.bloomTexB) this.bloomTexB.destroy();

    this.depthTexture = this.device.createTexture({
      size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
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
    this.hdrView = this.hdrTexture.createView();
    this.bloomViewA = this.bloomTexA.createView();
    this.bloomViewB = this.bloomTexB.createView();

    const postExtras = [
      { binding: 4, resource: this.depthView },
      { binding: 5, resource: { buffer: this.uniformBuffer } }
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

  render(uniformData, clearColor) {
    if (!this.depthTexture || !this.sceneBuffers) return;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
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

    shadowPass.setPipeline(this.shadowInstancedPipeline);
    const drawShadowInst = (vb, ib, idxCount, instB, instCount) => {
      if (instCount <= 0) return;
      shadowPass.setVertexBuffer(0, vb);
      shadowPass.setVertexBuffer(1, instB);
      shadowPass.setIndexBuffer(ib, 'uint32');
      shadowPass.drawIndexed(idxCount, instCount, 0, 0, 0);
    };
    drawShadowInst(sb.trunkAVB, sb.trunkAIB, sb.trunkAIdxCount, sb.trunkAInstB, sb.trunkAInstCount);
    drawShadowInst(sb.trunkBVB, sb.trunkBIB, sb.trunkBIdxCount, sb.trunkBInstB, sb.trunkBInstCount);
    drawShadowInst(sb.canopyAVB, sb.canopyAIB, sb.canopyAIdxCount, sb.canopyAInstB, sb.canopyAInstCount);
    drawShadowInst(sb.canopyBVB, sb.canopyBIB, sb.canopyBIdxCount, sb.canopyBInstB, sb.canopyBInstCount);
    drawShadowInst(sb.rockVB, sb.rockIB, sb.rockIdxCount, sb.rockInstB, sb.rockInstCount);
    drawShadowInst(sb.logVB, sb.logIB, sb.logIdxCount, sb.logInstB, sb.logInstCount);
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

    // Céu
    hdrPass.setPipeline(this.skyPipeline);
    hdrPass.draw(3, 1, 0, 0);

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
    const drawMainInst = (vb, ib, idxCount, instB, instCount) => {
      if (instCount <= 0) return;
      hdrPass.setVertexBuffer(0, vb);
      hdrPass.setVertexBuffer(1, instB);
      hdrPass.setIndexBuffer(ib, 'uint32');
      hdrPass.drawIndexed(idxCount, instCount, 0, 0, 0);
    };
    drawMainInst(sb.trunkAVB, sb.trunkAIB, sb.trunkAIdxCount, sb.trunkAInstB, sb.trunkAInstCount);
    drawMainInst(sb.trunkBVB, sb.trunkBIB, sb.trunkBIdxCount, sb.trunkBInstB, sb.trunkBInstCount);
    drawMainInst(sb.rockVB, sb.rockIB, sb.rockIdxCount, sb.rockInstB, sb.rockInstCount);
    drawMainInst(sb.logVB, sb.logIB, sb.logIdxCount, sb.logInstB, sb.logInstCount);
    drawMainInst(sb.mushVB, sb.mushIB, sb.mushIdxCount, sb.mushInstB, sb.mushInstCount);

    // Folhagem Dupla-Face Instanciada
    hdrPass.setPipeline(this.foliageInstancedPipeline);
    drawMainInst(sb.canopyAVB, sb.canopyAIB, sb.canopyAIdxCount, sb.canopyAInstB, sb.canopyAInstCount);
    drawMainInst(sb.canopyBVB, sb.canopyBIB, sb.canopyBIdxCount, sb.canopyBInstB, sb.canopyBInstCount);
    drawMainInst(sb.fernVB, sb.fernIB, sb.fernIdxCount, sb.fernInstB, sb.fernInstCount);
    drawMainInst(sb.grassVB, sb.grassIB, sb.grassIdxCount, sb.grassInstB, sb.grassInstCount);

    // Esporos & Vagalumes
    if (sb.sporeCount > 0) {
      hdrPass.setPipeline(this.sporePipeline);
      hdrPass.setVertexBuffer(0, sb.sporeInstB);
      hdrPass.draw(6, sb.sporeCount, 0, 0);
    }
    hdrPass.end();

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
  a.download = 'sylvan-canopy-modular-webgpu.zip';
  a.click();
  URL.revokeObjectURL(url);
}

export class SylvanApp {
  constructor(rawModulesSource) {
    this.rawModulesSource = rawModulesSource;
    this.canvas = document.getElementById('viewport');
    this.renderer = null;
    this.world = new ForestWorld(2026);
    this.audio = new ForestAudio();

    this.qualityKey = 'high';
    this.timeOfDay = 0.22;
    this.fogDensity = 0.55;
    this.windStrength = 0.65;
    this.autoTour = false;

    // Câmera inicia na clareira olhando para o riacho e raios de sol
    this.cam = {
      pos: [4.5, 2.2, 14.0],
      yaw: Math.PI + 0.12,
      pitch: 0.06,
      vel: [0, 0, 0],
      flyOffset: 0
    };

    this.keys = new Set();
    this.isDragging = false;
    this.lastMouse = [0, 0];
    this.uniformData = new Float32Array(80); // 320 bytes

    this.projMat = Mat4.create();
    this.viewMat = Mat4.create();
    this.vpMat = Mat4.create();
    this.invVpMat = Mat4.create();
    this.lightProj = Mat4.create();
    this.lightView = Mat4.create();
    this.lightVpMat = Mat4.create();

    this.lastFrameTime = performance.now();
    this.fpsFrames = 0;
    this.fpsTimer = 0;
  }

  async bootstrap() {
    const preset = QUALITY_PRESETS[this.qualityKey];
    this.renderer = new WebGPURenderer(this.canvas);
    if (!(await this.renderer.init(preset.shadowRes))) {
      this.renderer = null;
      document.getElementById('backend-text-intro').textContent = 'WebGPU indisponível neste navegador — use Chrome, Edge ou Safari 18+';
      document.getElementById('api-pill').textContent = 'Sem WebGPU';
      return;
    }

    document.getElementById('backend-text-intro').textContent = 'Motor WebGPU HDR • Sombras & PBR Ativos';
    document.getElementById('api-pill').textContent = this.renderer.api;

    this.rebuildWorld();
    this.handleResize();
    this.bindUI();

    this.cam.pos[1] = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]) + 2.0;
    requestAnimationFrame((t) => this.loop(t));
  }

  rebuildWorld() {
    const preset = QUALITY_PRESETS[this.qualityKey];
    const meshes = {
      terrain: this.world.buildTerrainMesh(preset.terrainRes),
      water: this.world.buildWaterMesh(96),
      trunkA: this.world.buildTreeTrunkMesh(0),
      trunkB: this.world.buildTreeTrunkMesh(1),
      canopyA: this.world.buildCanopyClusterMesh(0),
      canopyB: this.world.buildCanopyClusterMesh(1),
      fern: this.world.buildFernMesh(),
      grass: this.world.buildGrassMesh(),
      rock: this.world.buildRockMesh(),
      log: this.world.buildFallenLogMesh(),
      mushroom: this.world.buildMushroomMesh()
    };
    const instances = this.world.generateInstances(preset);
    this.renderer.uploadScene(meshes, instances, preset.shadowRes);
    document.getElementById('val-instances').textContent = `${preset.label} (${instances.trunkACount + instances.trunkBCount} árvores)`;
    document.getElementById('seed-badge').textContent = `#${this.world.seed}`;
  }

  handleResize() {
    const preset = QUALITY_PRESETS[this.qualityKey];
    const w = Math.floor(window.innerWidth * preset.dpr);
    const h = Math.floor(window.innerHeight * preset.dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer.resize(w, h);
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
        'README.md': `# Sylvan Canopy — Ultra-Realistic WebGPU Procedural Forest\n\nArquitetura modular inspirada em Abyssal Garden.\n\n## Estrutura\n- \`index.html\`: Interface HUD e ponto de entrada ES Module\n- \`src/math.js\`: PRNG determinístico, ruído FBM/Ridge e Mat4\n- \`src/quality.js\`: Presets de qualidade gráfica e shadow maps\n- \`src/world.js\`: Gerador procedural de mapa unificado — vale florestal com riacho rodeado por maciço montanhoso (cristas ridged fbm, estratos, picos nevados)\n- \`src/shaders.js\`: Shaders PBR Cook-Torrance GGX, Shadow Mapping PCF 3x3, céu atmosférico com nuvens procedurais, sombras de nuvens e estrelas, God Rays e Bloom HDR\n- \`src/audio.js\`: Sintetizador Web Audio procedural\n- \`src/main.js\`: Orquestrador de renderização WebGPU\n- \`textures/\`: Texturas do pacote de mídia do Shadertoy (CC BY-NC-SA 3.0)\n\n## Como Executar\nSirva a pasta com qualquer servidor HTTP local (ex: \`npx serve .\` ou \`python -m http.server\`).`,
        'index.html': this.rawModulesSource['index.html'],
        'src/math.js': this.rawModulesSource['math.js'],
        'src/quality.js': this.rawModulesSource['quality.js'],
        'src/world.js': this.rawModulesSource['world.js'],
        'src/shaders.js': this.rawModulesSource['shaders.js'],
        'src/audio.js': this.rawModulesSource['audio.js'],
        'src/main.js': this.rawModulesSource['main.js']
      };
      // Inclui as texturas fotográficas (pacote de mídia do Shadertoy, CC BY-NC-SA)
      for (const t of ['textures/bark.jpg', 'textures/rock.jpg', 'textures/pebbles.png', 'textures/noise.png', 'textures/stars.jpg',
                       'textures/litter.jpg', 'textures/wetstones.jpg', 'textures/twigs.jpg', 'textures/bark2.jpg',
                       'textures/granite.jpg', 'textures/graynoise.png', 'textures/wood.jpg']) {
        try { zipFiles[t] = new Uint8Array(await (await fetch(t)).arrayBuffer()); } catch (e) { /* servidor sem a pasta textures */ }
      }
      downloadModularZip(zipFiles);
    });

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        if (this.autoTour) this.setAutoTour(false);
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
        if (this.autoTour) this.setAutoTour(false);
      } else if (this.isDragging) {
        const dx = e.clientX - this.lastMouse[0];
        const dy = e.clientY - this.lastMouse[1];
        this.lastMouse = [e.clientX, e.clientY];
        this.cam.yaw -= dx * 0.004;
        this.cam.pitch = Math.max(-1.42, Math.min(1.42, this.cam.pitch - dy * 0.004));
        if (this.autoTour) this.setAutoTour(false);
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
        if (this.autoTour) this.setAutoTour(false);
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
      const totalMins = Math.floor((6 + v * 15) * 60);
      const hh = String(Math.floor(totalMins / 60) % 24).padStart(2, '0');
      const mm = String(totalMins % 60).padStart(2, '0');
      let period = 'Zênite Esmeralda';
      if (v < 0.18) period = 'Alvorecer';
      else if (v < 0.36) period = 'Manhã Dourada';
      else if (v < 0.68) period = 'Zênite Esmeralda';
      else if (v < 0.84) period = 'Crepúsculo';
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

    document.getElementById('slider-wind').addEventListener('input', (e) => {
      this.windStrength = parseFloat(e.target.value);
      document.getElementById('val-wind').textContent = `${Math.round((this.windStrength / 1.5) * 100)}%`;
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

    document.getElementById('btn-tour').addEventListener('click', () => {
      this.setAutoTour(!this.autoTour);
    });

    const panel = document.getElementById('controls-panel');
    document.getElementById('btn-toggle-hud').addEventListener('click', () => {
      panel.classList.toggle('opacity-0');
      panel.classList.toggle('pointer-events-none');
      panel.classList.toggle('translate-y-4');
    });
  }

  setAutoTour(enabled) {
    this.autoTour = enabled;
    document.getElementById('tour-label').textContent = enabled ? 'Passeio Auto' : 'Câmera Livre';
  }

  updateCamera(dt, elapsedSec) {
    if (this.autoTour) {
      const angle = elapsedSec * 0.075;
      const radius = 24.0 + Math.sin(elapsedSec * 0.14) * 9.0;
      this.cam.pos[0] = Math.cos(angle) * radius;
      this.cam.pos[2] = Math.sin(angle) * radius;
      const groundY = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]);
      this.cam.pos[1] = groundY + 3.0 + Math.sin(elapsedSec * 0.35) * 0.85;
      this.cam.yaw = -angle - Math.PI * 0.5 + Math.sin(elapsedSec * 0.22) * 0.35;
      this.cam.pitch = 0.05 + Math.sin(elapsedSec * 0.28) * 0.07;
      return;
    }

    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 14.0 : 6.4;
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

    const limit = this.world.worldSize * 0.43;
    this.cam.pos[0] = Math.max(-limit, Math.min(limit, this.cam.pos[0] + this.cam.vel[0] * dt));
    this.cam.pos[2] = Math.max(-limit, Math.min(limit, this.cam.pos[2] + this.cam.vel[2] * dt));

    if (this.keys.has('Space')) this.cam.flyOffset = Math.min(24.0, this.cam.flyOffset + dt * 7.5);
    if (this.keys.has('KeyC')) this.cam.flyOffset = Math.max(0.0, this.cam.flyOffset - dt * 7.5);

    const groundY = this.world.getTerrainHeight(this.cam.pos[0], this.cam.pos[2]);
    const bob = len > 0.1 && this.cam.flyOffset < 0.2 ? Math.sin(elapsedSec * 9.5) * 0.055 : 0;
    const targetY = Math.max(groundY, -2.1) + 1.85 + this.cam.flyOffset + bob;
    this.cam.pos[1] += (targetY - this.cam.pos[1]) * damping;
  }

  computeAtmosphere() {
    const sunAngle = (this.timeOfDay - 0.1) * Math.PI * 1.15;
    const elevation = Math.sin(sunAngle);
    const sunDir = [
      Math.cos(sunAngle) * 0.72,
      Math.max(0.08, elevation),
      Math.sin(sunAngle * 0.7 + 0.4) * 0.68
    ];
    const sLen = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
    sunDir[0] /= sLen; sunDir[1] /= sLen; sunDir[2] /= sLen;

    const dayFactor = Math.max(0, Math.min(1, elevation * 1.45 + 0.15));
    const goldenFactor = Math.exp(-Math.pow((elevation - 0.18) / 0.24, 2.0));

    const sunColor = [
      0.16 + dayFactor * 0.95 + goldenFactor * 0.55,
      0.24 + dayFactor * 0.82 + goldenFactor * 0.18,
      0.38 + dayFactor * 0.55 - goldenFactor * 0.15
    ];

    const skyTop = [
      0.02 + dayFactor * 0.14,
      0.05 + dayFactor * 0.30,
      0.09 + dayFactor * 0.26
    ];

    const skyHorizon = [
      0.04 + dayFactor * 0.24 + goldenFactor * 0.38,
      0.09 + dayFactor * 0.38 + goldenFactor * 0.22,
      0.11 + dayFactor * 0.28
    ];

    const fogColor = [
      0.03 + dayFactor * 0.15 + goldenFactor * 0.20,
      0.07 + dayFactor * 0.26 + goldenFactor * 0.12,
      0.08 + dayFactor * 0.20
    ];

    return { sunDir, sunColor, skyTop, skyHorizon, fogColor, elevation: Math.max(0, elevation) };
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
      document.getElementById('fps-counter').textContent = `${fps} FPS`;
      this.fpsFrames = 0;
      this.fpsTimer = 0;
    }

    this.updateCamera(dt, elapsedSec);

    const streamX = this.world.getStreamOffset(this.cam.pos[2]);
    this.audio.update(this.windStrength, Math.abs(this.cam.pos[0] - streamX), elapsedSec);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    Mat4.perspective(this.projMat, (60 * Math.PI) / 180, aspect, 0.2, 230.0);

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

    const atm = this.computeAtmosphere();

    // Matriz de Sombra Ortográfica centrada ao redor da câmera
    const shadowExtent = 68.0;
    const lightEye = [
      this.cam.pos[0] + atm.sunDir[0] * 85.0,
      atm.sunDir[1] * 85.0,
      this.cam.pos[2] + atm.sunDir[2] * 85.0
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

    u[48] = this.cam.pos[0]; u[49] = this.cam.pos[1]; u[50] = this.cam.pos[2]; u[51] = 1.0;
    u[52] = atm.sunDir[0];   u[53] = atm.sunDir[1];   u[54] = atm.sunDir[2];   u[55] = 0.0;
    u[56] = atm.sunColor[0]; u[57] = atm.sunColor[1]; u[58] = atm.sunColor[2]; u[59] = 1.0;
    u[60] = atm.skyTop[0];   u[61] = atm.skyTop[1];   u[62] = atm.skyTop[2];   u[63] = 1.0;
    u[64] = atm.skyHorizon[0]; u[65] = atm.skyHorizon[1]; u[66] = atm.skyHorizon[2]; u[67] = 1.0;
    u[68] = atm.fogColor[0]; u[69] = atm.fogColor[1]; u[70] = atm.fogColor[2]; u[71] = 1.0;

    u[72] = elapsedSec;
    u[73] = this.windStrength;
    u[74] = this.fogDensity;
    u[75] = atm.elevation;

    u[76] = preset.godRaySteps;
    u[77] = 1.05;
    u[78] = 0.0028;
    u[79] = aspect;

    this.renderer.render(u, atm.skyHorizon);
    requestAnimationFrame((t) => this.loop(t));
  }
}