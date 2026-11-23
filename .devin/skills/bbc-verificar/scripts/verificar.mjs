// ============================================================================
// verificar.mjs — Verificação pós-tarefa completa: checagens estáticas +
// app aberto no Chrome headless (erros de WGSL/GPU/console, pill de API,
// HUD, FPS e captura de tela com resumo numérico)
// Uso: node .devin/skills/bbc-verificar/scripts/verificar.mjs
//      [--qualidade=medium|high|ultra|cinematic] [--out=/tmp/bbc-verificar.png]
//      [--estatico]  (pula o navegador)
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseArgs, openApp, imageStats, sleep } from './lib.mjs';
import { staticChecks, printReport } from './checar.mjs';

const args = parseArgs();
const out = args.out || '/tmp/bbc-verificar.png';

const stat = await staticChecks();
printReport(stat);
const errors = [...stat.errors], warnings = [...stat.warnings];

// Acha a linha do WGSL culpado nos fontes (o número que o Tint informa é
// relativo ao template já interpolado, não ao arquivo)
function locate(srcLine) {
  if (!srcLine) return '';
  const hits = [];
  for (const f of ['src/shaders.js', 'src/island.js']) {
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((l, i) => { if (l.trim() === srcLine) hits.push(`${f}:${i + 1}`); });
  }
  return hits.length ? ` → ${hits.slice(0, 3).join(', ')}` : ' → linha gerada por interpolação (ISLAND_WGSL em src/island.js)';
}

if (!args.estatico && stat.errors.some((e) => e.startsWith('Sintaxe inválida'))) {
  console.log('\n== Navegador ==\n  pulado: corrija primeiro o erro de sintaxe acima.');
} else if (!args.estatico) {
  console.log('\n== Navegador (Chrome headless + WebGPU) ==');
  const app = await openApp({ quality: args.qualidade || null }).catch((e) => {
    console.log(`  ERRO  ${e.message}\n\nFALHOU: não foi possível abrir o app.`);
    process.exit(1);
  });
  const { page } = app;
  try {
    console.log(`  servidor: porta 3000 ${app.server.reused ? '(já estava no ar, reaproveitado)' : '(iniciado pelo script)'}`);
    console.log(`  pill de API: "${app.pill}"`);
    if (app.pill !== 'WebGPU HDR') errors.push(`Pill de API mostra "${app.pill}" em vez de "WebGPU HDR" — o renderer não inicializou (veja os erros de WGSL/console abaixo).`);
    else if (!app.ready) errors.push('O mundo não terminou de gerar em 180s (val-instances nunca mostrou "N árvores").');

    if (app.ready) {
      const hud = await page.evaluate(`(async () => {
        const $ = (id) => document.getElementById(id);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const fails = [];
        for (const id of ['viewport', 'api-pill', 'seed-badge', 'fps-counter', 'btn-toggle-hud', 'controls-panel', 'slider-time', 'slider-fog', 'slider-wind', 'btn-regen', 'btn-tour', 'btn-audio', 'btn-download-zip', 'val-instances']) {
          if (!$(id)) fails.push('elemento #' + id + ' sumiu do index.html');
        }
        if (fails.length) return { fails };
        const app = window.bigBuck;
        const slide = (id, val, label, prop) => {
          const before = $(label).textContent, keep = $(id).value;
          $(id).value = val; $(id).dispatchEvent(new Event('input'));
          if ($(label).textContent === before || Math.abs(app[prop] - parseFloat($(id).value)) > 1e-6) fails.push('slider #' + id + ' não atualizou ' + prop + '/#' + label);
          $(id).value = keep; $(id).dispatchEvent(new Event('input'));
        };
        slide('slider-time', '0.5', 'val-time', 'timeOfDay');
        slide('slider-fog', '0.9', 'val-fog', 'fogDensity');
        slide('slider-wind', '1.2', 'val-wind', 'windStrength');
        const tour = $('tour-label').textContent;
        $('btn-tour').click();
        if ($('tour-label').textContent === tour) fails.push('botão "Câmera Livre"/passeio não alternou');
        $('btn-tour').click();
        if (document.querySelectorAll('.q-btn').length !== 4) fails.push('esperava 4 botões de qualidade (.q-btn)');
        await wait(3500);
        return { fails, fps: $('fps-counter').textContent, instances: $('val-instances').textContent, seed: $('seed-badge').textContent, scale: app.renderScale };
      })()`);
      for (const f of hud.fails) errors.push(`HUD: ${f}.`);
      if (!hud.fails.length || hud.fps) {
        console.log(`  HUD: ${hud.fails.length ? 'COM FALHAS' : 'sliders e botões respondem'}`);
        console.log(`  mundo: ${hud.instances} · semente ${hud.seed}`);
        console.log(`  FPS: ${hud.fps} (escala de resolução ${Math.round(hud.scale * 100)}% — headless, serve só de referência)`);
        if (!/^[1-9]\d* FPS/.test(hud.fps)) errors.push(`O contador de FPS mostra "${hud.fps}" — o loop de render não está rodando.`);
      }
      await sleep(300);
      const s = imageStats(await page.screenshot(out));
      console.log(`  captura: ${out} (${s.width}×${s.height}) — brilho médio ${s.brilho}/255, contraste ${s.contraste}`);
      console.log(`  cores médias 3×3 (linhas de cima para baixo): ${s.grade.slice(0, 3).join(' ')} | ${s.grade.slice(3, 6).join(' ')} | ${s.grade.slice(6).join(' ')}`);
      if (s.brilho < 6) errors.push(`A captura está preta (brilho ${s.brilho}/255) — a cena não está sendo desenhada; veja os erros de WGSL/GPU.`);
      else if (s.contraste < 4) errors.push(`A captura está praticamente uniforme (contraste ${s.contraste}) — a cena não está sendo desenhada (tela preta/lisa).`);
    }

    const gpu = await app.readGpu().catch(() => null);
    for (const m of gpu?.wgsl || []) {
      const where = `${m.module === 0 ? 'WGSL_SHADERS' : 'WGSL_POST_SHADERS'} linha ${m.line}:${m.col}`;
      const text = `WGSL ${m.type} em ${where}: ${m.msg}\n        código: ${m.src}${locate(m.src)}`;
      (m.type === 'error' ? errors : warnings).push(text);
    }
    const gpuCount = new Map();
    for (const m of gpu?.gpu || []) gpuCount.set(m.trim(), (gpuCount.get(m.trim()) || 0) + 1);
    for (const [m, n] of gpuCount) errors.push(`Erro de validação da GPU${n > 1 ? ` (×${n})` : ''}: ${m.split('\n').slice(0, 6).join('\n        ')}`);
    for (const m of app.log.exceptions) errors.push(`Exceção de JavaScript: ${m}`);
    for (const m of app.log.http) errors.push(`HTTP ${m}`);
    const seen = new Set();
    for (const m of app.log.console) {
      const short = m.split('\n').slice(0, 4).join('\n        ');
      // Erros da GPU já entraram acima, com contagem; o aviso do Tailwind CDN é esperado
      if (seen.has(short) || /cdn\.tailwindcss\.com/.test(m) || [...gpuCount.keys()].some((g) => m.includes(g.split('\n')[0]))) continue;
      seen.add(short);
      (m.startsWith('[error]') ? errors : warnings).push(`Console ${short}`);
    }
  } finally {
    await app.close();
  }
  console.log('  servidor e navegador encerrados.');
  for (const w of warnings.slice(stat.warnings.length)) console.log(`  AVISO ${w}`);
  for (const e of errors.slice(stat.errors.length)) console.log(`  ERRO  ${e}`);
}

console.log(errors.length
  ? `\nFALHOU: ${errors.length} erro(s). Corrija e rode de novo.`
  : `\nOK: verificação completa sem erros${warnings.length ? ` (${warnings.length} aviso(s))` : ''}.`);
process.exit(errors.length ? 1 : 0);
