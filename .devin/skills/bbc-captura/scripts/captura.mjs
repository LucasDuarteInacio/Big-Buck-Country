// ============================================================================
// captura.mjs — Captura de tela do mundo no Chrome headless, com câmera,
// hora do dia e névoa escolhidas (vistas prontas ou pose livre)
// Uso: node .devin/skills/bbc-captura/scripts/captura.mjs --vista=partida
//      node .devin/skills/bbc-captura/scripts/captura.mjs --pos=212,313 --altura=40 --yaw=3.1 --pitch=-0.3 --hora=0.5
// Opções: --vista=<nome|todas> --pos=x,z --altura=m --yaw=rad --pitch=rad
//         --hora=0..1 --nevoa=0..1 --chuva=0..1 --qualidade=medium|high|ultra|cinematic
//         --out=arquivo.png|.jpg --largura=1280 --altura-tela=720 --hud --lista
// ============================================================================

import { parseArgs, openApp, imageStats, sleep } from '../../bbc-verificar/scripts/lib.mjs';

// pos = [x, z] em metros (origem no centro da ilha, +x leste, +z sul);
// 'spawn' = ponto de partida. altura = metros acima do chão (modo voo).
// yaw: 0 olha para +z (sul), π/2 para +x (leste), π para o norte.
// pitch > 0 olha para cima. hora: 0 alvorecer … 0.5 meio-dia … 1 noite
const VISTAS = {
  partida:    { pos: 'spawn', altura: 0, hora: 0.22, nevoa: 0.55, desc: 'ponto de partida: rio sul, olhando o maciço' },
  aerea:      { pos: [650, 950], altura: 380, yaw: -2.54, pitch: -0.36, hora: 0.45, nevoa: 0.04, desc: 'ilha inteira vista do alto, a sudeste' },
  macico:     { pos: [150, 330], altura: 45, yaw: -2.77, pitch: 0.08, hora: 0.4, nevoa: 0.12, desc: 'cristas do maciço central vistas do vale sul' },
  praia:      { pos: [530, 667], altura: 1.5, yaw: -0.6, pitch: -0.06, hora: 0.4, nevoa: 0.2, desc: 'restinga de areia no sudeste, mar à esquerda' },
  sotobosque: { pos: 'spawn', altura: 0, pitch: -0.3, hora: 0.35, nevoa: 0.5, desc: 'chão da mata na margem do rio' },
  entardecer: { pos: 'spawn', altura: 25, hora: 0.8, nevoa: 0.4, desc: 'crepúsculo sobre a mata' },
  noite:      { pos: 'spawn', altura: 0, hora: 0.95, nevoa: 0.45, desc: 'noite bioluminescente' }
};

const args = parseArgs();
if (args.lista) {
  for (const [k, v] of Object.entries(VISTAS)) console.log(`${k.padEnd(11)} ${v.desc}`);
  process.exit(0);
}
const num = (v, d) => (v === undefined || v === true ? d : parseFloat(v));
const names = args.vista === 'todas' ? Object.keys(VISTAS) : [args.vista || (args.pos ? null : 'partida')];
for (const n of names) if (n && !VISTAS[n]) { console.error(`Vista "${n}" não existe. Use --lista.`); process.exit(2); }

const app = await openApp({ width: num(args.largura, 1280), height: num(args['altura-tela'], 720), quality: args.qualidade || null }).catch((e) => {
  console.error('ERRO: ' + e.message);
  process.exit(1);
});
let failed = false;
try {
  if (!app.ready) throw new Error(`O app não ficou pronto (pill de API: "${app.pill}"). Rode o verificar.mjs para ver o motivo.`);
  const { page } = app;
  await page.evaluate(`(() => { const a = window.bigBuck; a.autoScale = () => {}; a.renderScale = 1; a.handleResize(); a.setAutoTour(false); })()`);
  if (!args.hud) await page.evaluate(`document.getElementById('btn-toggle-hud').click()`);

  for (const name of names) {
    const v = { ...(name ? VISTAS[name] : {}) };
    if (args.pos) v.pos = String(args.pos).split(',').map(Number);
    v.altura = num(args.altura, v.altura ?? 0);
    v.yaw = num(args.yaw, v.yaw);
    v.pitch = num(args.pitch, v.pitch);
    v.hora = num(args.hora, v.hora ?? 0.22);
    v.nevoa = num(args.nevoa, v.nevoa ?? 0.55);
    v.chuva = num(args.chuva, v.chuva ?? 0);
    const out = args.out && names.length === 1 ? args.out : `/tmp/bbc-${name || 'captura'}.png`;
    const pose = await page.evaluate(`(() => {
      const a = window.bigBuck, v = ${JSON.stringify(v)};
      const p = v.pos === 'spawn' || !v.pos ? a.world.spawn.cam : v.pos;
      a.cam.pos[0] = p[0]; a.cam.pos[2] = p[1];
      a.cam.vel = [0, 0, 0];
      a.cam.flying = v.altura > 0;
      a.cam.pos[1] = Math.max(a.world.getTerrainHeight(p[0], p[1]), -2.1) + 1.85 + v.altura;
      a.cam.yaw = v.yaw ?? a.world.spawn.yaw;
      a.cam.pitch = v.pitch ?? 0.06;
      a.timeOfDay = v.hora; a.fogDensity = v.nevoa; a.rainIntensity = v.chuva;
      return { x: a.cam.pos[0], y: a.cam.pos[1], z: a.cam.pos[2], yaw: a.cam.yaw, pitch: a.cam.pitch, chao: a.world.getTerrainHeight(p[0], p[1]), costa: a.world.shoreDist(p[0], p[1]) };
    })()`);
    await sleep(1500);
    const s = imageStats(await page.screenshot(out.endsWith('.jpg') ? '/tmp/bbc-stats.png' : out));
    if (out.endsWith('.jpg')) await page.screenshot(out);
    console.log(`${out}`);
    console.log(`  câmera: x=${pose.x.toFixed(1)} y=${pose.y.toFixed(1)} z=${pose.z.toFixed(1)} yaw=${pose.yaw.toFixed(2)} pitch=${pose.pitch.toFixed(2)} · chão ${pose.chao.toFixed(1)} m · ${pose.costa > 0 ? `${pose.costa.toFixed(0)} m terra adentro` : `${(-pose.costa).toFixed(0)} m mar afora`}`);
    console.log(`  hora ${v.hora} · névoa ${v.nevoa} · chuva ${v.chuva} · brilho ${s.brilho}/255 · contraste ${s.contraste}`);
    console.log(`  cores 3×3: ${s.grade.slice(0, 3).join(' ')} | ${s.grade.slice(3, 6).join(' ')} | ${s.grade.slice(6).join(' ')}`);
  }
  const gpu = await app.readGpu();
  const wgslErr = gpu.wgsl.filter((m) => m.type === 'error').length;
  if (wgslErr || app.log.exceptions.length) {
    console.log(`ATENÇÃO: ${wgslErr} erro(s) de WGSL e ${app.log.exceptions.length} exceção(ões) de JS — rode o verificar.mjs.`);
    failed = true;
  }
} catch (e) {
  console.error('ERRO: ' + e.message);
  failed = true;
} finally {
  await app.close();
}
process.exit(failed ? 1 : 0);
