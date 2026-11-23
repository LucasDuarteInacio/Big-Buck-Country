// ============================================================================
// quality.js — Presets de Qualidade Gráfica, Shadow Maps e Densidade
// ============================================================================

// As contagens são o total na ilha inteira (~2 km² de mata fechada). O custo
// por frame não vem delas: o renderer só desenha as células visíveis, com
// copa em detalhe cheio até treeDetailDist (m), copa de cartões planos até
// treeLodDist — além disso a árvore vira o LOD distante — e sub-bosque
// (samambaia, grama, cogumelos) até understoryDist
export const QUALITY_PRESETS = {
  medium: {
    label: 'Médio',
    dpr: Math.min(window.devicePixelRatio || 1, 1.25),
    shadowRes: 1024,
    godRaySteps: 12,
    terrainRes: 380,
    trees: 12000,
    foliageClusters: 168000,
    ferns: 200000,
    grassTufts: 320000,
    rocks: 3800,
    fallenLogs: 1500,
    mushrooms: 13500,
    spores: 3400,
    treeDetailDist: 50,
    treeLodDist: 150,
    understoryDist: 70
  },
  high: {
    label: 'Alto',
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    shadowRes: 2048,
    godRaySteps: 20,
    terrainRes: 540,
    trees: 18000,
    foliageClusters: 288000,
    ferns: 320000,
    grassTufts: 520000,
    rocks: 6000,
    fallenLogs: 2500,
    mushrooms: 27500,
    spores: 6000,
    treeDetailDist: 65,
    treeLodDist: 220,
    understoryDist: 95
  },
  ultra: {
    label: 'Ultra',
    dpr: Math.min(window.devicePixelRatio || 1, 2.0),
    shadowRes: 3072,
    godRaySteps: 28,
    terrainRes: 680,
    trees: 24000,
    foliageClusters: 384000,
    ferns: 420000,
    grassTufts: 700000,
    rocks: 8000,
    fallenLogs: 3300,
    mushrooms: 39000,
    spores: 9000,
    treeDetailDist: 85,
    treeLodDist: 280,
    understoryDist: 120
  },
  cinematic: {
    label: 'Cinematográfico',
    dpr: Math.min(window.devicePixelRatio || 1, 2.0),
    shadowRes: 4096,
    godRaySteps: 36,
    terrainRes: 820,
    trees: 30000,
    foliageClusters: 480000,
    ferns: 520000,
    grassTufts: 900000,
    rocks: 10000,
    fallenLogs: 4200,
    mushrooms: 52000,
    spores: 12500,
    treeDetailDist: 105,
    treeLodDist: 340,
    understoryDist: 145
  }
};
