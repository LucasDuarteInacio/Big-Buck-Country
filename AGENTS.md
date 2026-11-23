# AGENTS.md — Sylvan Canopy

Guia para agentes de IA trabalharem neste repositório.

## Visão Geral do Projeto

**Sylvan Canopy** é um motor de floresta procedural ultra-realista renderizado em **WebGPU**, escrito em **JavaScript puro (ES Modules)**, sem build step, sem `package.json` e sem dependências de npm — o único recurso externo é o Tailwind via CDN em `index.html`. A arquitetura é modular, inspirada em "Abyssal Garden".

O app renderiza dois biomas selecionáveis no HUD:

- **Floresta**: duas espécies de árvores, copas multicamadas, riacho e bioluminescência.
- **Montanha**: cristas com ridged FBM, estratos rochosos, picos nevados e prado alpino (inspirado no "Canyon" do iq).

Pipeline de renderização: PBR Cook-Torrance GGX, shadow mapping com PCF 3x3, céu atmosférico com nuvens procedurais, sombras de nuvens, estrelas, God Rays e Bloom HDR — tudo em WGSL.

## Estrutura de Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | HUD (Tailwind CDN), canvas e entry point `<script type="module">` que importa `SylvanApp` e carrega os fontes para o exportador ZIP |
| `src/main.js` | `WebGPURenderer` (device, pipelines, shadow pass, HDR/bloom post) + `SylvanApp` (orquestração, câmera, input, UI, loop). Também contém `downloadModularZip`, o exportador `.zip` do projeto |
| `src/world.js` | `ForestWorld` — geração procedural: heightmap por bioma, construtores de mesh (`buildTerrainMesh`, `buildTreeTrunkMesh`, `buildCanopyClusterMesh`, `buildFernMesh`, `buildGrassMesh`, `buildRockMesh`, `buildFallenLogMesh`, `buildMushroomMesh`, `buildWaterMesh`) e `generateInstances(preset)` |
| `src/shaders.js` | `WGSL_SHADERS` (pipeline principal) e `WGSL_POST_SHADERS` (pós-processamento) como template literals WGSL |
| `src/math.js` | `PRNG` (determinístico), `ProceduralNoise` (value noise, FBM, ridge) e `Mat4` |
| `src/quality.js` | `QUALITY_PRESETS`: `medium`, `high`, `ultra`, `cinematic` — dpr, `shadowRes`, `godRaySteps`, `terrainRes` e contagens de instâncias |
| `src/audio.js` | `ForestAudio` — sintetizador procedural Web Audio |
| `textures/` | Texturas fotográficas do pacote de mídia do Shadertoy (bark, rock, pebbles, noise, stars) — **CC BY-NC-SA 3.0**, © shadertoy.com |

## Como Executar

Não há build. Sirva a pasta estaticamente — **sempre na porta 3000**:

```bash
cd /Users/lucasduarte/Downloads/sylvan-canopy-modular-webgpu
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

### Exportador ZIP

`index.html` carrega os fontes de cada módulo via `fetch` e `main.js` monta o `.zip`. **Ao adicionar/renomear um módulo, atualizar as duas listas**: o array `files` no `<script type="module">` do `index.html` e o objeto `zipFiles` em `downloadModularZip`.

### Texturas

`loadTextures()` em `main.js` tem a lista de arquivos. Nova textura → adicionar ao array, bind group layout e bindings WGSL correspondentes. Respeitar a licença CC BY-NC-SA 3.0 dos assets do Shadertoy.

## Verificação Pós-Tarefa (obrigatória)

Ao terminar **qualquer** tarefa que altere código:

1. Subir o servidor na porta 3000 em background:
   ```bash
   cd /Users/lucasduarte/Downloads/sylvan-canopy-modular-webgpu
   python3 -m http.server 3000
   ```
2. Abrir `http://localhost:3000` (browser preview se disponível) e verificar:
   - Página carrega sem erros no console (erros WGSL/compilação de pipeline aparecem como `Tint WGSL` ou `validation error`).
   - Pill de API no topo exibe **"WebGPU HDR"** (se o ambiente de teste não tiver WebGPU, ao menos confirmar que a página serve sem erro de JS/módulo — `curl -s http://localhost:3000` e `curl -sI http://localhost:3000/src/main.js` retornam 200).
   - HUD funcional: slider de hora do dia, botões de bioma (Floresta/Montanha), presets de qualidade e botão "Nova Semente".
   - Render correta: terreno, vegetação, céu e água visíveis; FPS contando no canto superior direito.
3. Checar sintaxe rápida dos módulos alterados: `node --check src/<arquivo>.js` (vale para parsing, não para WGSL embutido).
4. Encerrar o servidor de teste ao final.

## Limitações Conhecidas

- Sem suite de testes, lint ou CI — verificação é manual via browser.
- WebGPU indisponível em Firefox estável e navegadores antigos (comportamento esperado: mensagem de aviso).
- `python3 -m http.server` já resolve o MIME type de `.js` corretamente; qualquer servidor estático funciona.
