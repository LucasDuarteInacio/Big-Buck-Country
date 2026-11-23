// ============================================================================
// quality.js — Presets de Qualidade Gráfica, Shadow Maps e Densidade
// ============================================================================

export const QUALITY_PRESETS = {
  medium: {
    label: 'Médio',
    dpr: Math.min(window.devicePixelRatio || 1, 1.25),
    shadowRes: 1024,
    godRaySteps: 12,
    terrainRes: 150,
    trees: 170,
    foliageClusters: 2400,
    ferns: 3200,
    grassTufts: 4500,
    rocks: 150,
    fallenLogs: 28,
    mushrooms: 260,
    spores: 1100
  },
  high: {
    label: 'Alto',
    dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    shadowRes: 2048,
    godRaySteps: 20,
    terrainRes: 210,
    trees: 260,
    foliageClusters: 4200,
    ferns: 6200,
    grassTufts: 9000,
    rocks: 240,
    fallenLogs: 44,
    mushrooms: 480,
    spores: 2000
  },
  ultra: {
    label: 'Ultra',
    dpr: Math.min(window.devicePixelRatio || 1, 2.0),
    shadowRes: 3072,
    godRaySteps: 28,
    terrainRes: 260,
    trees: 360,
    foliageClusters: 6500,
    ferns: 9800,
    grassTufts: 14500,
    rocks: 340,
    fallenLogs: 62,
    mushrooms: 750,
    spores: 3200
  },
  cinematic: {
    label: 'Cinematográfico',
    dpr: Math.min(window.devicePixelRatio || 1, 2.0),
    shadowRes: 4096,
    godRaySteps: 36,
    terrainRes: 310,
    trees: 460,
    foliageClusters: 9200,
    ferns: 14000,
    grassTufts: 21000,
    rocks: 450,
    fallenLogs: 85,
    mushrooms: 1100,
    spores: 4500
  }
};