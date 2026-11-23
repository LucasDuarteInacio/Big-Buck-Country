// ============================================================================
// quality.js — Presets de Qualidade Gráfica, Shadow Maps e Densidade
// ============================================================================

export const QUALITY_PRESETS = {
  medium: {
    label: 'Médio',
    dpr: Math.min(window.devicePixelRatio || 1, 1.25),
    shadowRes: 1024,
    godRaySteps: 12,
    terrainRes: 190,
    trees: 290,
    foliageClusters: 4100,
    ferns: 5500,
    grassTufts: 7800,
    rocks: 260,
    fallenLogs: 48,
    mushrooms: 440,
    spores: 1900
  },
  high: {
    label: 'Alto',
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    shadowRes: 2048,
    godRaySteps: 20,
    terrainRes: 265,
    trees: 440,
    foliageClusters: 7100,
    ferns: 10500,
    grassTufts: 15000,
    rocks: 410,
    fallenLogs: 75,
    mushrooms: 820,
    spores: 3400
  },
  ultra: {
    label: 'Ultra',
    dpr: Math.min(window.devicePixelRatio || 1, 2.0),
    shadowRes: 3072,
    godRaySteps: 28,
    terrainRes: 335,
    trees: 610,
    foliageClusters: 11000,
    ferns: 16500,
    grassTufts: 24500,
    rocks: 580,
    fallenLogs: 105,
    mushrooms: 1280,
    spores: 5400
  },
  cinematic: {
    label: 'Cinematográfico',
    dpr: Math.min(window.devicePixelRatio || 1, 2.0),
    shadowRes: 4096,
    godRaySteps: 36,
    terrainRes: 390,
    trees: 780,
    foliageClusters: 15500,
    ferns: 23500,
    grassTufts: 35500,
    rocks: 770,
    fallenLogs: 145,
    mushrooms: 1900,
    spores: 7700
  }
};
