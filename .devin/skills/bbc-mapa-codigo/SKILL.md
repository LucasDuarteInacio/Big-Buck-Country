---
name: bbc-mapa-codigo
description: Mapa do código do Big Buck Country - em qual arquivo e função fica cada coisa (renderer WebGPU, shaders WGSL, geração do mundo, planta da ilha, presets, HUD, áudio), como os dados fluem do preset até a GPU e quais contratos entre módulos quebram em silêncio. Use no começo de qualquer tarefa neste repositório, antes de abrir os arquivos grandes, para decidir onde editar e qual skill bbc-* seguir.
allowed-tools:
  - read
  - grep
  - glob
---

# Mapa do código

Os arquivos são grandes (`main.js`, `world.js` e `shaders.js` têm ~1300 linhas
cada). **Não leia arquivos inteiros.** Ache a função pelo nome com grep e leia só
o trecho. Números de linha mudam; nomes de função não.

```bash
grep -n "nomeDaFuncao" src/*.js        # onde está
sed -n '120,180p' src/world.js         # ler só o trecho
```

## Qual skill usar

| A tarefa é sobre... | Skill |
|---|---|
| cor, luz, material, água, céu, névoa, pós-processamento, uniform, textura | `bbc-shader` |
| relevo, costa, rios, praia, maciço, onde a mata cresce | `bbc-terreno` |
| novo tipo de objeto/planta, contagens, LOD, parâmetro de preset | `bbc-instancias` |
| ver o resultado, comparar antes/depois, imagens do README | `bbc-captura` |
| terminar qualquer tarefa (obrigatório) | `bbc-verificar` |

## Onde fica cada coisa

| Quero mexer em... | Arquivo | Procure por |
|---|---|---|
| Contorno da costa, espinha do maciço, traçado dos rios | `src/island.js` | `export const ISLAND` |
| Ponto de partida da câmera | `src/island.js` | `computeSpawn` |
| Espelho WGSL da planta (gerado, não editar à mão os números) | `src/island.js` | `ISLAND_WGSL` |
| Altura do terreno | `src/world.js` | `getTerrainHeight` |
| Máscaras: costa, maciço, rio, mata | `src/world.js` | `shoreDist`, `mountMask`, `riverMask`, `riverCore`, `forestDensity` |
| Cor do chão por vértice, máscaras de areia/campo no uv | `src/world.js` | `buildTerrainMesh` |
| Forma de tronco, copa, samambaia, grama, rocha, tronco caído, cogumelo | `src/world.js` | `buildTreeTrunkMesh`, `buildCanopyClusterMesh`, `buildFernMesh`, `buildGrassMesh`, `buildRockMesh`, `buildFallenLogMesh`, `buildMushroomMesh` |
| Onde cada coisa é plantada | `src/world.js` | `generateInstances` |
| Quantidades, resoluções, distâncias de LOD | `src/quality.js` | `QUALITY_PRESETS` |
| Aparência por material (chão, casca, folha, rocha, água...) | `src/shaders.js` | `fn fsMain` e os ramos `mat == N` |
| Vento, fade do sub-bosque | `src/shaders.js` | `fn applyWind`, `fn vsInstanced` |
| Sombras | `src/shaders.js` | `fn sampleShadowPCF`, `vsShadowInstanced`, `fsShadowClip` |
| Água: profundidade, correnteza, espuma | `src/shaders.js` | `fn waterDepthAt`, `fn waterSurf`, `fn waterFoamTex`, ramo `mat == 6` |
| Céu, nuvens, estrelas, sol | `src/shaders.js` | `fn fsSky`, `fn cloudDens`, `fn cloudDensity` |
| God rays, SSAO, bloom, tone mapping | `src/shaders.js` | `WGSL_POST_SHADERS`: `computeGodRays`, `computeSSAO`, `fsBloomExtract`, `fsBlur`, `fsComposite` |
| Cor do sol/céu/névoa por hora do dia | `src/main.js` | `computeAtmosphere` |
| Valores enviados ao shader a cada frame | `src/main.js` | `u[48]` (fim de `loop`) |
| Pipelines, bind group layouts, layout de vértice | `src/main.js` | `createPipelines` |
| Lista de texturas | `src/main.js` | `loadTextures` |
| Quais meshes existem e como viram camadas | `src/main.js` | `rebuildWorld`, `INSTANCE_LAYERS`, `uploadScene` |
| Culling e LOD por célula | `src/main.js` | `selectCells`, `drawLayer` |
| Ordem dos passes de render | `src/main.js` | `render(uniformData` |
| Câmera e teclado/mouse | `src/main.js` | `updateCamera`, `bindUI` |
| Escala dinâmica de resolução | `src/main.js` | `autoScale` |
| Botões e sliders do HUD | `index.html` + `src/main.js` | o `id` do elemento, `bindUI` |
| Som | `src/audio.js` | `ForestAudio` |
| Ruído, PRNG, matrizes | `src/math.js` | `PRNG`, `ProceduralNoise`, `Mat4` |

## Fluxo dos dados

```
quality.js  preset ─┐
island.js   planta ─┤
                    ▼
world.js    build*Mesh()            → { vertices: Float32Array (12 floats/vértice), indices: Uint32Array }
            generateInstances(p)    → listas de 8 floats/instância ordenadas por célula + grid
                    ▼
main.js     rebuildWorld()          monta `meshes` e chama renderer.uploadScene(meshes, instances, shadowRes)
            INSTANCE_LAYERS         [mesh, lista, pipeline, faixa de LOD, projeta sombra]
            loop() → uniformData    80 floats = struct FrameUniforms do WGSL
            render()                sombra → terreno+água → sólidos → folhagem → céu → esporos → bloom → composite
                    ▼
shaders.js  vsTerrain/vsInstanced → fsMain (ramo por matId) ; fsSky ; pós
```

Formatos fixos:

- **Vértice** (12 floats): posição 3, normal 3, cor 3, uv 2, matId 1. Montado por `packMesh`.
- **Instância** (8 floats): x, y, z, escala, rotY, fase do vento, tint, peso do vento. Montada por `InstanceList.push`.
- **Material IDs**: 0 terreno · 1 casca A · 2 folha lanceolada · 3 samambaia/grama · 4 rocha · 5 cogumelo · 6 água · 7 folha redonda · 8 casca B · 9 tronco caído · 10 folha rubra · 11 espuma de rio.
- **Coordenadas**: metros, origem no centro da ilha, +x leste, +z sul, +y para cima. Nível d'água em `world.waterLevel`.

## Contratos que quebram em silêncio

Mudou um lado, mude o outro **na mesma edição**. O `checar.mjs` confere quase todos.

| Se você mudar... | Também mude... |
|---|---|
| `struct FrameUniforms` (WGSL_SHADERS) | `struct FrameView` (WGSL_POST_SHADERS), `uniformData` e os `u[N]` em `main.js` |
| um `@binding` no WGSL | o layout em `createPipelines()` **e** as entradas do bind group |
| a lista de `loadTextures()` | a lista de texturas do ZIP em `bindUI()`, o layout e o binding WGSL |
| um campo de `QUALITY_PRESETS` | os **4** presets |
| uma fórmula de praia/várzea/leito/mar em `getTerrainHeight` | `waterDepthAt` em `shaders.js` |
| `shoreDist` | `islandShore` em `shaders.js` |
| `ProceduralNoise` (`hash2`, `noise2D`, `fbm`) | `worldHash`, `worldNoise2D`, `worldFbm3` em `shaders.js` |
| um módulo em `src/` (novo ou renomeado) | array `files` em `index.html` **e** `zipFiles` em `main.js` |
| um mesh novo | `meshes` em `rebuildWorld`, `INSTANCE_LAYERS`, lista em `generateInstances` |
| um `matId` novo | ramo `mat == N` no `fsMain` |

## Regras do projeto (resumo do AGENTS.md)

- JavaScript puro com ES Modules. **Sem** npm, TypeScript, bundler ou framework.
- Comentários, textos de interface e mensagens em **português (pt-BR)**.
- Geração do mundo **só** com `PRNG`/`ProceduralNoise`. Nunca `Math.random()` em `world.js`, `island.js` ou `math.js`.
- Números de qualidade **só** em `QUALITY_PRESETS`.
- Não remova comentários existentes. Não adicione comentários óbvios.
- Arquivo novo em `src/` abre com o banner `// ====...====`.
- Preserve assinaturas e call sites: `rebuildWorld` é o contrato central.

## Antes de editar

1. Diga em uma frase o que vai mudar e em quais funções.
2. Leia a função inteira que vai editar e quem a chama (`grep -n "nome(" src/*.js`).
3. Mudança visual? Capture o "antes" (`bbc-captura`).
4. Faça a **menor** mudança que resolve. Uma coisa por vez.
5. Rode `node .devin/skills/bbc-verificar/scripts/checar.mjs` a cada edição e o `verificar.mjs` no fim.
