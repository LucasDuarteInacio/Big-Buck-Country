// ============================================================================
// checar.mjs — Checagens estáticas (sem navegador) dos contratos entre os
// módulos: sintaxe, listas do exportador ZIP, presets, uniforms, bindings,
// camadas de instância, materiais, espelho JS↔WGSL e determinismo do mundo
// Uso: node .devin/skills/bbc-verificar/scripts/checar.mjs
// ============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const sameSet = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
// Trecho de `text` que começa em `start` e vai até o primeiro `end` depois dele
const between = (text, start, end) => {
  const i = text.indexOf(start);
  if (i < 0) return null;
  const j = text.indexOf(end, i + start.length);
  return j < 0 ? null : text.slice(i, j);
};

export async function staticChecks() {
  const errors = [], warnings = [], passed = [];
  const check = (name, fn) => {
    const before = errors.length;
    try { fn(); } catch (e) { errors.push(`${name}: a checagem falhou ao ler o código (${e.message}) — o trecho que ela procura mudou de forma?`); }
    if (errors.length === before) passed.push(name);
  };
  const checkAsync = async (name, fn) => {
    const before = errors.length;
    try { await fn(); } catch (e) { errors.push(`${name}: ${e.stack?.split('\n').slice(0, 3).join(' | ') || e.message}`); }
    if (errors.length === before) passed.push(name);
  };

  const modules = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).sort();
  const src = Object.fromEntries(modules.map((f) => [f, read(`src/${f}`)]));
  const main = src['main.js'], world = src['world.js'], html = read('index.html');

  check('sintaxe (node --check)', () => {
    for (const f of modules) {
      const r = spawnSync(process.execPath, ['--check', join(ROOT, 'src', f)], { encoding: 'utf8' });
      if (r.status !== 0) errors.push(`Sintaxe inválida em src/${f}:\n${r.stderr.trim().split('\n').slice(0, 6).join('\n')}`);
    }
  });

  check('cabeçalho de banner', () => {
    for (const f of modules) if (!src[f].startsWith('// ====')) errors.push(`src/${f} não abre com o cabeçalho de banner "// ===...===".`);
  });

  check('imports entre módulos', () => {
    for (const f of modules) {
      for (const m of src[f].matchAll(/from\s+'\.\/([\w.-]+)'/g)) {
        if (!modules.includes(m[1])) errors.push(`src/${f}:${lineOf(src[f], m.index)} importa './${m[1]}', que não existe em src/.`);
      }
    }
  });

  check('listas do exportador ZIP', () => {
    const want = ['index.html', ...modules.map((f) => `src/${f}`)].sort();
    const htmlList = [...(/const files = \[([^\]]*)\]/.exec(html)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const zipList = [...main.matchAll(/'((?:src\/)?[\w.-]+\.(?:js|html))': this\.rawModulesSource\['([\w.-]+)'\]/g)];
    if (!sameSet(want, htmlList)) errors.push(`index.html: o array \`files\` tem [${htmlList.join(', ')}], mas os módulos são [${want.join(', ')}].`);
    if (!sameSet(want, zipList.map((m) => m[1]).sort())) errors.push(`main.js: \`zipFiles\` (downloadModularZip) tem [${zipList.map((m) => m[1]).sort().join(', ')}], mas os módulos são [${want.join(', ')}].`);
    for (const m of zipList) if (m[1].replace(/^src\//, '') !== m[2]) errors.push(`main.js: zipFiles['${m[1]}'] lê rawModulesSource['${m[2]}'] (nomes diferentes).`);
  });

  check('determinismo (sem Math.random no mundo)', () => {
    for (const f of ['world.js', 'island.js', 'math.js']) {
      for (const m of (src[f] || '').matchAll(/Math\.random\s*\(/g)) errors.push(`src/${f}:${lineOf(src[f], m.index)} usa Math.random() — use o PRNG com seed.`);
    }
  });

  let presets = null;
  await checkAsync('presets de qualidade', async () => {
    globalThis.window ??= { devicePixelRatio: 1 };
    presets = (await import(pathToFileURL(join(ROOT, 'src/quality.js')).href)).QUALITY_PRESETS;
    const names = Object.keys(presets);
    if (!sameSet(names, ['medium', 'high', 'ultra', 'cinematic'])) errors.push(`quality.js: presets esperados medium/high/ultra/cinematic, encontrados ${names.join('/')}.`);
    const keys = Object.keys(presets[names[0]]);
    for (const n of names) {
      const k = Object.keys(presets[n]);
      const missing = keys.filter((x) => !k.includes(x)), extra = k.filter((x) => !keys.includes(x));
      if (missing.length) errors.push(`quality.js: preset '${n}' não tem o(s) campo(s) ${missing.join(', ')} (existem em '${names[0]}').`);
      if (extra.length) errors.push(`quality.js: preset '${n}' tem campo(s) ${extra.join(', ')} que faltam em '${names[0]}'.`);
      for (const x of k) if (x !== 'label' && !Number.isFinite(presets[n][x])) errors.push(`quality.js: ${n}.${x} não é um número finito.`);
    }
    const used = new Set();
    for (const f of ['main.js', 'world.js']) {
      for (const m of src[f].matchAll(/\bpreset\.(\w+)/g)) {
        used.add(m[1]);
        if (!keys.includes(m[1])) errors.push(`src/${f}:${lineOf(src[f], m.index)} lê preset.${m[1]}, que não existe em QUALITY_PRESETS.`);
      }
    }
    for (const k of keys) if (!used.has(k)) warnings.push(`quality.js: o campo '${k}' não é lido em main.js nem em world.js.`);
    for (const m of html.matchAll(/data-quality="(\w+)"/g)) if (!names.includes(m[1])) errors.push(`index.html: botão data-quality="${m[1]}" sem preset correspondente.`);
  });

  let wgsl = null;
  await checkAsync('shaders.js carrega no Node', async () => {
    wgsl = await import(pathToFileURL(join(ROOT, 'src/shaders.js')).href);
    for (const k of ['WGSL_SHADERS', 'WGSL_POST_SHADERS']) {
      if (typeof wgsl[k] !== 'string') errors.push(`shaders.js não exporta ${k} como string.`);
      else if (/\bundefined\b|\bNaN\b|\[object /.test(wgsl[k])) errors.push(`${k}: a interpolação do template gerou "undefined"/"NaN"/"[object" dentro do WGSL.`);
    }
  });

  const structFields = (code, name) => {
    const body = new RegExp(`struct ${name}\\s*\\{([^}]*)\\}`).exec(code)?.[1];
    if (!body) return null;
    return [...body.matchAll(/^\s*(\w+)\s*:\s*([\w<>]+)\s*,/gm)].map((m) => ({ name: m[1], type: m[2] }));
  };
  if (wgsl) check('uniforms (struct WGSL ↔ uniformData)', () => {
    const SIZE = { 'mat4x4<f32>': 64, 'vec4<f32>': 16 };
    const a = structFields(wgsl.WGSL_SHADERS, 'FrameUniforms'), b = structFields(wgsl.WGSL_POST_SHADERS, 'FrameView');
    if (!a || !b) { errors.push('Não achei `struct FrameUniforms` (WGSL_SHADERS) ou `struct FrameView` (WGSL_POST_SHADERS).'); return; }
    if (a.map((f) => f.name + ':' + f.type).join() !== b.map((f) => f.name + ':' + f.type).join()) {
      errors.push(`FrameUniforms (pipeline principal) e FrameView (pós) têm campos diferentes — as duas structs leem o mesmo buffer e precisam ser idênticas.\n  FrameUniforms: ${a.map((f) => f.name).join(', ')}\n  FrameView:     ${b.map((f) => f.name).join(', ')}`);
    }
    let bytes = 0;
    for (const f of a) {
      if (!SIZE[f.type]) { errors.push(`FrameUniforms.${f.name}: tipo ${f.type} — use só mat4x4<f32> e vec4<f32> (sem padding implícito para errar o offset).`); return; }
      bytes += SIZE[f.type];
    }
    const floats = +(/this\.uniformData = new Float32Array\((\d+)\)/.exec(main)?.[1] || 0);
    if (floats * 4 !== bytes) errors.push(`FrameUniforms ocupa ${bytes} bytes (${bytes / 4} floats), mas main.js cria uniformData = new Float32Array(${floats}).`);
    const maxIdx = Math.max(...[...main.matchAll(/\bu\[(\d+)\]\s*=/g)].map((m) => +m[1]));
    if (maxIdx >= floats) errors.push(`main.js escreve u[${maxIdx}], fora do uniformData de ${floats} floats.`);
    const bufSize = +(/this\.uniformBuffer = dev\.createBuffer\(\{\s*size:\s*(\d+)/.exec(main)?.[1] || 0);
    if (bufSize < bytes) errors.push(`uniformBuffer tem ${bufSize} bytes, menor que a struct (${bytes}).`);
  });

  const wgslBindings = (code) => {
    const out = new Map();
    for (const m of code.matchAll(/@group\(0\)\s*@binding\((\d+)\)\s*var(<uniform>)?\s+(\w+)\s*:\s*([\w<>]+)/g)) {
      const t = m[4];
      const kind = m[2] ? 'buffer' : t === 'texture_depth_2d' ? 'texture:depth' : t.startsWith('texture_') ? 'texture:float'
        : t === 'sampler_comparison' ? 'sampler:comparison' : t === 'sampler' ? 'sampler:filtering' : t;
      out.set(+m[1], { name: m[3], kind });
    }
    return out;
  };
  const layoutBindings = (name) => {
    const block = between(main, `this.${name} = dev.createBindGroupLayout({`, '});');
    if (!block) return null;
    const out = new Map();
    for (const m of block.matchAll(/binding:\s*(\d+),[^\n]*?(buffer|texture|sampler):\s*\{\s*(?:type|sampleType):\s*'([\w-]+)'/g)) {
      out.set(+m[1], m[2] === 'buffer' ? 'buffer' : `${m[2]}:${m[3] === 'unfilterable-float' ? 'float' : m[3]}`);
    }
    return out;
  };
  if (wgsl) check('bindings (WGSL ↔ bind group layouts)', () => {
    for (const [layoutName, code, label] of [['mainBindGroupLayout', wgsl.WGSL_SHADERS, 'WGSL_SHADERS'], ['postBindGroupLayout', wgsl.WGSL_POST_SHADERS, 'WGSL_POST_SHADERS']]) {
      const sh = wgslBindings(code), lay = layoutBindings(layoutName);
      if (!lay) { errors.push(`Não achei this.${layoutName} em createPipelines().`); continue; }
      for (const [n, b] of sh) {
        if (!lay.has(n)) errors.push(`${label}: @binding(${n}) ${b.name} não tem entrada em ${layoutName} (main.js, createPipelines).`);
        else if (lay.get(n) !== b.kind) errors.push(`${label}: @binding(${n}) ${b.name} é ${b.kind} no WGSL, mas ${lay.get(n)} em ${layoutName}.`);
      }
      for (const n of lay.keys()) if (!sh.has(n)) warnings.push(`${layoutName}: binding ${n} existe no layout mas não é declarado em ${label}.`);
    }
    const group = between(main, 'layout: this.mainBindGroupLayout,', '});');
    const lay = layoutBindings('mainBindGroupLayout');
    if (!group || !lay) { errors.push('Não achei o bind group principal (rebuildShadowTexture).'); return; }
    const entries = [...group.matchAll(/binding:\s*(\d+)/g)].map((m) => +m[1]);
    for (const n of lay.keys()) if (!entries.includes(n)) errors.push(`mainBindGroup (rebuildShadowTexture): falta a entrada do binding ${n} declarado no layout.`);
    for (const n of entries) if (!lay.has(n)) errors.push(`mainBindGroup (rebuildShadowTexture): binding ${n} não existe em mainBindGroupLayout.`);
    const texList = [...(between(main, 'const files = [', ']') || '').matchAll(/'(textures\/[^']+)'/g)].map((m) => m[1]);
    const maxView = Math.max(...[...group.matchAll(/textureViews\[(\d+)\]/g)].map((m) => +m[1]));
    if (maxView >= texList.length) errors.push(`mainBindGroup usa textureViews[${maxView}], mas loadTextures() só carrega ${texList.length} texturas.`);
    for (const t of texList) if (!existsSync(join(ROOT, t))) errors.push(`loadTextures(): ${t} não existe.`);
    const zipTex = [...(between(main, "for (const t of ['textures/", ']') || '').matchAll(/'(textures\/[^']+)'/g)].map((m) => m[1]);
    if (!sameSet(texList, zipTex)) errors.push(`A lista de texturas do exportador ZIP (bindUI) difere da de loadTextures(): faltam no ZIP [${texList.filter((t) => !zipTex.includes(t)).join(', ')}], sobram [${zipTex.filter((t) => !texList.includes(t)).join(', ')}].`);
  });

  if (wgsl) check('entry points dos pipelines', () => {
    const all = wgsl.WGSL_SHADERS + wgsl.WGSL_POST_SHADERS;
    for (const m of main.matchAll(/entryPoint:\s*'(\w+)'/g)) {
      if (!new RegExp(`\\bfn ${m[1]}\\s*\\(`).test(all)) errors.push(`main.js:${lineOf(main, m.index)} usa entryPoint '${m[1]}', que não existe no WGSL.`);
    }
  });

  check('camadas de instância (INSTANCE_LAYERS)', () => {
    const rows = [...(between(main, 'const INSTANCE_LAYERS = [', '];') || '').matchAll(/\['(\w+)',\s*'(\w+)',\s*'(\w+)',\s*'(\w+)',\s*(true|false)\]/g)];
    const meshKeys = [...(between(main, 'const steps = [', '];') || '').matchAll(/\['(\w+)'/g)].map((m) => m[1]);
    const listKeys = [...(between(world, 'const lists = {', '};') || '').matchAll(/(\w+):\s*\[/g)].map((m) => m[1]);
    const tiers = [...(/for \(const tier of \[([^\]]+)\]/.exec(main)?.[1] || '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    if (!rows.length || !meshKeys.length || !listKeys.length) { errors.push('Não consegui ler INSTANCE_LAYERS, `steps` (rebuildWorld) ou `lists` (generateInstances).'); return; }
    for (const [, mesh, list, pipe, tier] of rows) {
      if (!meshKeys.includes(mesh)) errors.push(`INSTANCE_LAYERS: mesh '${mesh}' não está no array \`steps\` de rebuildWorld() (main.js).`);
      if (!listKeys.includes(list)) errors.push(`INSTANCE_LAYERS: lista '${list}' não está em \`lists\` de generateInstances() (world.js).`);
      if (!['solid', 'foliage'].includes(pipe)) errors.push(`INSTANCE_LAYERS: pipeline '${pipe}' inválido (use 'solid' ou 'foliage').`);
      if (!tiers.includes(tier)) errors.push(`INSTANCE_LAYERS: faixa '${tier}' inválida (use ${tiers.filter((t) => t !== 'shadow').join(', ')}).`);
    }
    const usedMeshes = rows.map((r) => r[1]), usedLists = rows.map((r) => r[2]);
    // 'hands' não é camada instanciada: é o viewmodel do modo jogo, desenhado
    // num passe próprio pelo handsPipeline
    for (const k of meshKeys) if (!['terrain', 'water', 'hands'].includes(k) && !usedMeshes.includes(k)) warnings.push(`rebuildWorld(): mesh '${k}' é construído mas nenhuma camada de INSTANCE_LAYERS o desenha.`);
    for (const k of listKeys) if (!usedLists.includes(k)) warnings.push(`generateInstances(): lista '${k}' é gerada mas nenhuma camada de INSTANCE_LAYERS a usa.`);
  });

  if (wgsl) check('material IDs (world.js ↔ fsMain)', () => {
    const handled = new Set([...wgsl.WGSL_SHADERS.matchAll(/\bmat == (\d+)/g)].map((m) => +m[1]));
    for (const m of world.matchAll(/this\.packMesh\([^;]*?,\s*([^,;]+)\);/g)) {
      for (const n of m[1].matchAll(/(\d+)(?:\.0)?/g)) {
        if (!handled.has(+n[1])) errors.push(`world.js:${lineOf(world, m.index)} cria mesh com matId ${n[1]}, mas o fsMain não tem ramo \`mat == ${n[1]}\`.`);
      }
    }
  });

  let island = null;
  await checkAsync('espelho JS ↔ WGSL (waterDepthAt)', async () => {
    island = await import(pathToFileURL(join(ROOT, 'src/island.js')).href);
    const S = island.WORLD_SIZE;
    const fn = between(wgsl?.WGSL_SHADERS || '', 'fn waterDepthAt(', '\n  }\n');
    if (!fn) { warnings.push('Não achei fn waterDepthAt no WGSL.'); return; }
    const waterLevel = +(/this\.waterLevel = (-?[\d.]+)/.exec(world)?.[1]);
    if (!fn.includes(String(waterLevel))) errors.push(`waterDepthAt não usa o nível d'água ${waterLevel} de world.js (this.waterLevel).`);
    // Constantes de getTerrainHeight em metros que o shader repete por extenso
    const mirrored = [['S*0.04 (mergulho no mar)', 0.04], ['S*0.06 (restinga)', 0.06], ['S*0.07 (riverCore)', 0.07], ['S*0.15 (declive do leito)', 0.15], ['S*0.045 (cabeceira)', 0.045], ['S*0.03 (mountMask)', 0.03], ['S*0.065 (mountMask)', 0.065]];
    for (const [label, k] of mirrored) {
      const v = (S * k).toFixed(1);
      if (!fn.includes(v)) warnings.push(`waterDepthAt: não achei ${v} = ${label}. Se a fórmula mudou em getTerrainHeight/mountMask/riverCore (world.js), espelhe em waterDepthAt (shaders.js).`);
    }
  });

  await checkAsync('mundo gera no Node e é determinístico', async () => {
    const { ForestWorld } = await import(pathToFileURL(join(ROOT, 'src/world.js')).href);
    const tiny = { ...presets.medium, terrainRes: 96 };
    for (const k of ['trees', 'foliageClusters', 'ferns', 'grassTufts', 'rocks', 'fallenLogs', 'mushrooms', 'spores']) tiny[k] = Math.max(8, Math.floor(tiny[k] / 60));
    const run = () => {
      const w = new ForestWorld(2026);
      const inst = w.generateInstances(tiny);
      let hash = 0;
      for (const k of Object.keys(inst.grid.starts)) for (let i = 0; i < inst[k].length; i += 7) hash = (hash * 31 + Math.fround(inst[k][i]) * 1000) | 0;
      return { w, inst, hash };
    };
    const a = run(), b = run();
    if (a.hash !== b.hash) errors.push('generateInstances() não é determinístico: duas execuções com a mesma seed deram instâncias diferentes.');
    for (const k of Object.keys(a.inst.grid.starts)) {
      if (a.inst[k].some((v) => !Number.isFinite(v))) errors.push(`generateInstances(): a lista '${k}' contém NaN/Infinity.`);
      if (a.inst[k].length === 0) warnings.push(`generateInstances(): a lista '${k}' saiu vazia (preset reduzido de teste).`);
    }
    const S = a.w.worldSize;
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 0.618034) % 1 - 0.5) * S, z = ((i * 0.754878) % 1 - 0.5) * S;
      if (!Number.isFinite(a.w.getTerrainHeight(x, z))) { errors.push(`getTerrainHeight(${x.toFixed(1)}, ${z.toFixed(1)}) devolveu NaN/Infinity.`); break; }
    }
    const [sx, sz] = a.w.spawn.cam;
    if (!(a.w.shoreDist(sx, sz) > 0)) errors.push(`A câmera inicial (${sx.toFixed(1)}, ${sz.toFixed(1)}) nasce fora da ilha (shoreDist <= 0).`);
    if (a.w.getTerrainHeight(S * 0.49, S * 0.49) > a.w.waterLevel) errors.push('O canto do mapa está acima do nível do mar — a ilha vaza da borda do mundo.');
  });

  return { errors, warnings, passed };
}

export function printReport({ errors, warnings, passed }, title = 'Checagens estáticas') {
  console.log(`\n== ${title} ==`);
  for (const p of passed) console.log(`  ok    ${p}`);
  for (const w of warnings) console.log(`  AVISO ${w}`);
  for (const e of errors) console.log(`  ERRO  ${e}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await staticChecks();
  printReport(r);
  console.log(r.errors.length ? `\nFALHOU: ${r.errors.length} erro(s).` : `\nOK: nenhuma quebra de contrato${r.warnings.length ? ` (${r.warnings.length} aviso(s))` : ''}.`);
  process.exit(r.errors.length ? 1 : 0);
}
