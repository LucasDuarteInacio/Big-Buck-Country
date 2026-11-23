# AGENTS.md — Big Buck Country

Guia para agentes de IA trabalharem neste repositório.

## Visão Geral do Projeto

**Big Buck Country** é um motor de floresta procedural ultra-realista renderizado em **WebGPU**, escrito em **JavaScript puro (ES Modules)**, sem build step, sem `package.json` e sem dependências de npm — o único recurso externo é o Tailwind via CDN em `index.html`. A arquitetura é modular.

O app renderiza um único mundo: uma ilha de ~2.2km × 1.65km (`worldSize` 2600, origem no centro, +x leste / +z sul) cuja **planta vem de `src/island.js`** (traçada do mapa de referência): contorno da costa (série de Fourier polar), maciço central alongado SO–NE (cadeia de cápsulas) e cinco rios (polilinhas com meandros) que nascem rasos no sopé do maciço e correm até a foz. Do centro para fora:

- **Maciço**: cristas com FBM amortecido por derivada (`noised2`/`mountainIq`, portado do shader fdlyW4 do iq), scree ocre, picos nevados por altitude+declividade e prado alpino.
- **Floresta baixa**: duas espécies de árvores, copas multicamadas, rios correntes que deságuam no mar e bioluminescência. Mata fechada em torno da clareira de partida + capões, com campo aberto entre eles (`forestDensity`).
- **Restinga e mar**: praia de areia em toda a volta (~78m) e mergulho sob o oceano (104m).

As faixas derivam de `worldSize` e usam `shoreDist` (distância à costa, deformada por fbm). O `island.js` também gera o WGSL espelhado (`ISLAND_WGSL`: `islandCoastR`/`islandMountSdf`/`islandRiver`) usado por `islandShore`/`waterDepthAt` — mudou a planta, o shader acompanha sozinho; mudou uma **fórmula** de praia/várzea/leito/mar em `getTerrainHeight`, espelhar em `waterDepthAt`. O uv do terreno carrega máscaras de cobertura (x = areia, y = campo), lidas no `fsMain`. A câmera nasce em `world.spawn` (margem do rio sul, olhando o maciço).

O custo por frame é controlado por LOD de instâncias: o renderer só desenha as células visíveis, com copa em detalhe cheio até `treeDetailDist`, copa de cartões planos até `treeLodDist` e sub-bosque até `understoryDist` — todos campos dos presets em `quality.js`.

Pipeline de renderização: PBR Cook-Torrance GGX, shadow mapping com PCF 3x3, céu atmosférico com nuvens procedurais, sombras de nuvens, estrelas, God Rays, SSAO e Bloom HDR — tudo em WGSL.

## Estrutura de Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | HUD (Tailwind CDN), canvas e entry point `<script type="module">` que importa `BigBuckApp` e carrega os fontes para o exportador ZIP |
| `src/main.js` | `WebGPURenderer` (device, pipelines, shadow pass, HDR/bloom post) + `BigBuckApp` (orquestração, câmera, input, UI, loop). Também contém `downloadModularZip`, o exportador `.zip` do projeto |
| `src/world.js` | `ForestWorld` — geração procedural: heightmap da ilha, construtores de mesh (`buildTerrainMesh`, `buildTreeTrunkMesh`, `buildCanopyClusterMesh`, `buildFernMesh`, `buildGrassMesh`, `buildRockMesh`, `buildFallenLogMesh`, `buildMushroomMesh`, `buildWaterMesh`) e `generateInstances(preset)` |
| `src/island.js` | Planta da ilha: `WORLD_SIZE`, `ISLAND` (costa, espinha do maciço, rios), `coastRadius`/`mountSdf`/`riverDist`/`riverPoint`, `ISLAND_SPAWN` e o espelho `ISLAND_WGSL` interpolado em `WGSL_SHADERS` |
| `src/shaders.js` | `WGSL_SHADERS` (pipeline principal) e `WGSL_POST_SHADERS` (pós-processamento) como template literals WGSL |
| `src/math.js` | `PRNG` (determinístico), `ProceduralNoise` (value noise, FBM, ridge) e `Mat4` |
| `src/quality.js` | `QUALITY_PRESETS`: `medium`, `high`, `ultra`, `cinematic` — dpr, `shadowRes`, `godRaySteps`, `terrainRes`, contagens de instâncias e distâncias de LOD (`treeDetailDist`/`treeLodDist`/`understoryDist`) |
| `src/audio.js` | `ForestAudio` — sintetizador procedural Web Audio |
| `textures/` | Texturas fotográficas do pacote de mídia do Shadertoy (bark, rock, pebbles, noise, stars) — **CC BY-NC-SA 3.0**, © shadertoy.com |
| `screenshots/` | Capturas do mundo atual usadas no `README.md` |
| `godot/` | Port em progresso para Godot 4 + C# (mesma seed, mesma ilha) — tem o próprio `README.md` |

## Como Executar

Não há build. Sirva a pasta estaticamente — **sempre na porta 3000**:

```bash
cd /Users/lucasduarte/Documents/workspace/big-buck-country
python3 -m http.server 3000
# ou: npx serve . -l 3000
```

Abra `http://localhost:3000`. Requer navegador com WebGPU: Chrome/Edge recentes ou Safari 18+. Sem WebGPU, o app mostra aviso no overlay de intro (`api-pill` = "Sem WebGPU") — não há fallback WebGL.

## Convenções e Boas Práticas

### Código

- **JavaScript vanilla com ES Modules** (`import`/`export`). Não introduzir TypeScript, bundlers, npm ou frameworks — a ausência de toolchain é decisão de design.
- **Português (pt-BR)** nos comentários, strings de UI e mensagens de console, seguindo o estilo existente.
- Cada módulo abre com um cabeçalho de banner `// ===...===` descrevendo sua responsabilidade — manter esse padrão em arquivos novos.
- Código compacto e direto; sem comentários óbvios. Não remover comentários existentes.
- **Determinismo**: toda geração procedural usa `PRNG`/`ProceduralNoise` com seed — nunca `Math.random()` em código de mundo, para preservar reprodutibilidade por seed.
- Contagens de instâncias, resolução de terreno, DPR e parâmetros de shadow map vivem **somente** em `QUALITY_PRESETS` (`quality.js`). Novo parâmetro de qualidade → adicionar aos 4 presets, nunca hardcodear em `main.js`/`world.js`.
- Alterações em assinatura de função, nomes de campos de preset ou interface entre módulos devem preservar os call sites existentes (`rebuildWorld` em `main.js` é o contrato central: `meshes` + `generateInstances(preset)` → `renderer.uploadScene`).

### WGSL (`shaders.js`)

- Shaders ficam dentro dos template literals `WGSL_SHADERS` / `WGSL_POST_SHADERS`. Validar sintaxe WGSL ao editar — erro de shader só aparece em runtime no console do navegador.
- Ao alterar bindings/uniforms, manter o bind group layout em `createPipelines()` (`main.js`) e o tamanho/offset do `uniformData` (Float32Array de 80 elementos = 320 bytes) sincronizados com a `struct` WGSL.
- Pipeline de pós-processamento: **god rays e SSAO rodam no post, não no `fsMain`**. Os god rays marcham sobre o shadow map (bindings 6/7 do `postBindGroupLayout`) a partir do `worldPos` reconstruído do depth — 1x por pixel. O SSAO é calculado em meia-resolução dentro de `fsBloomExtract` e viaja no **canal alpha do bloom** (o blur separável o suaviza de graça); `fsComposite` lê `bloom.a`. Trocar a resolução do shadow map recria os bind groups de pós via `createPostBindGroups()`.

### Performance

- O céu é desenhado **depois** dos opacos (o depth test elimina pixels cobertos — `fsSky` é o fragment mais caro do frame).
- `BigBuckApp.autoScale` é o governador de FPS: escala `renderScale` (multiplicador do `dpr` do preset) para sustentar >=30 FPS e restaura 1.0 quando a GPU folga. Não é parâmetro de preset — é dinâmico em runtime.

### Exportador ZIP

`index.html` carrega os fontes de cada módulo via `fetch` e `main.js` monta o `.zip`. **Ao adicionar/renomear um módulo, atualizar as duas listas**: o array `files` no `<script type="module">` do `index.html` e o objeto `zipFiles` em `downloadModularZip`.

### Texturas

`loadTextures()` em `main.js` tem a lista de arquivos. Nova textura → adicionar ao array, bind group layout e bindings WGSL correspondentes. Respeitar a licença CC BY-NC-SA 3.0 dos assets do Shadertoy.

## Verificação Pós-Tarefa (obrigatória)

Ao terminar **qualquer** tarefa que altere código:

1. Subir o servidor na porta 3000 em background:
   ```bash
   cd /Users/lucasduarte/Documents/workspace/big-buck-country
   python3 -m http.server 3000
   ```
2. Abrir `http://localhost:3000` (browser preview se disponível) e verificar:
   - Página carrega sem erros no console (erros WGSL/compilação de pipeline aparecem como `Tint WGSL` ou `validation error`).
   - Pill de API no topo exibe **"WebGPU HDR"** (se o ambiente de teste não tiver WebGPU, ao menos confirmar que a página serve sem erro de JS/módulo — `curl -s http://localhost:3000` e `curl -sI http://localhost:3000/src/main.js` retornam 200).
   - HUD funcional: sliders de hora do dia, névoa e vento, presets de qualidade e os botões "Nova Semente", "Câmera Livre", som e "Baixar .zip".
   - Render correta: terreno, vegetação, céu e água visíveis; FPS contando no canto superior direito.
3. Checar sintaxe rápida dos módulos alterados: `node --check src/<arquivo>.js` (vale para parsing, não para WGSL embutido).
4. Encerrar o servidor de teste ao final.

### Screenshots do README

Para recapturar `screenshots/` sem interação manual: Playwright (`playwright-core`) apontando para o Chrome real (`executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`, headless, `--enable-unsafe-webgpu`) — WebGPU funciona em headless. Na página: clicar `#btn-enter`, esperar `val-instances` mostrar "N árvores", posicionar via `window.bigBuck` (`cam.pos`/`cam.yaw`/`cam.pitch`/`cam.flying`, `timeOfDay`, `fogDensity`) e congelar a resolução (`autoScale = () => {}; renderScale = 1; handleResize()`). O painel se esconde com `#btn-toggle-hud`.

## Skills do Projeto (`.devin/skills/`)

Roteiros passo a passo e scripts sem dependências (Node 22+ e Chrome) para trabalhar no repositório. **Comece toda tarefa pelo `bbc-mapa-codigo` e termine pelo `bbc-verificar`.**

| Skill | Quando usar |
|---|---|
| `bbc-mapa-codigo` | Início de qualquer tarefa: onde fica cada coisa e quais contratos mudam juntos |
| `bbc-shader` | Editar WGSL, uniforms, bindings, texturas, pós-processamento |
| `bbc-terreno` | Relevo, costa, rios, praia, mata — e o espelho `waterDepthAt` |
| `bbc-instancias` | Novo objeto/planta, contagens, LOD, campos de `QUALITY_PRESETS` |
| `bbc-captura` | Ver o resultado: captura de tela com câmera/hora/névoa escolhidas |
| `bbc-verificar` | Fim de qualquer tarefa: automatiza a verificação pós-tarefa acima |

```bash
node .devin/skills/bbc-verificar/scripts/checar.mjs      # contratos entre módulos, <1 s, sem navegador
node .devin/skills/bbc-verificar/scripts/verificar.mjs   # + Chrome headless: erros de WGSL/GPU/console, HUD, FPS, captura
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=partida
node .devin/skills/bbc-terreno/scripts/mapa.mjs --arvores  # mapa da ilha visto de cima + contagens
```

Os scripts reaproveitam um servidor já no ar na porta 3000 (ou sobem e encerram o próprio). Ao mudar um contrato entre módulos (novo binding, novo campo de uniform, nova lista), atualize a checagem correspondente em `checar.mjs`.

## Limitações Conhecidas

- Sem suite de testes, lint ou CI — verificação é manual via browser.
- WebGPU indisponível em Firefox estável e navegadores antigos (comportamento esperado: mensagem de aviso).
- `python3 -m http.server` já resolve o MIME type de `.js` corretamente; qualquer servidor estático funciona.
