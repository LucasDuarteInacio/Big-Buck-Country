---
name: bbc-verificar
description: Verificação pós-tarefa obrigatória do Big Buck Country. Roda checagens estáticas dos contratos entre módulos e abre o app no Chrome headless com WebGPU para capturar erros de WGSL, validação da GPU, console, HUD e FPS, com captura de tela. Use ao terminar QUALQUER alteração em src/ ou index.html, antes de dizer que a tarefa está pronta, e sempre que precisar descobrir por que o app não renderiza.
allowed-tools:
  - read
  - grep
  - glob
permissions:
  allow:
    - Exec(node .devin/skills/)
---

# Verificar o Big Buck Country

Erro de shader só aparece em runtime, e o projeto não tem testes. Este skill é o
substituto: **não declare a tarefa concluída sem o `verificar.mjs` terminar em `OK`.**

Rode sempre a partir da raiz do repositório. Requer Node 22+ e Google Chrome (sem npm).

## Passo a passo

1. Depois de **cada** edição, rode a checagem rápida (menos de 1 s, sem navegador):

   ```bash
   node .devin/skills/bbc-verificar/scripts/checar.mjs
   ```

2. Ao terminar a tarefa, rode a verificação completa (cerca de 15 s):

   ```bash
   node .devin/skills/bbc-verificar/scripts/verificar.mjs
   ```

   O script sobe o servidor na porta 3000 (ou reaproveita um que já esteja no ar),
   abre o app, e encerra tudo ao final. Não suba servidor à mão.

3. Leia a saída de baixo para cima. A última linha é `OK: ...` ou `FALHOU: N erro(s)`.
   - `ERRO` → corrija e volte ao passo 1. Nunca ignore.
   - `AVISO` → leia; só é aceitável se você souber explicar por quê.

4. Abra a captura `/tmp/bbc-verificar.png` com a ferramenta de leitura de arquivos e
   confira: terreno, vegetação, céu e água visíveis. Se você não consegue ver
   imagens, use os números impressos: `brilho` abaixo de 6 é tela preta e
   `contraste` abaixo de 4 é tela lisa — nos dois casos a cena quebrou (o script
   já acusa como erro).

5. Se mexeu em algo visual, compare antes/depois com o skill `bbc-captura`.

Opções: `--qualidade=medium|high|ultra|cinematic` (testa outro preset),
`--out=arquivo.png`, `--estatico` (só as checagens sem navegador).

## Como ler cada erro

| Mensagem | Causa | Onde consertar |
|---|---|---|
| `Sintaxe inválida em src/X.js` | erro de JavaScript | a linha indicada |
| `WGSL error em WGSL_SHADERS linha N` + `código: ...` → `src/shaders.js:L` | erro de shader | vá à linha `L` do arquivo (o `N` é do template já interpolado, **não** do arquivo). Veja o skill `bbc-shader` |
| `Pill de API mostra "Sem WebGPU"` | exceção em `init()`/`createPipelines()` | a exceção de JavaScript listada junto |
| `A captura está preta` com pill "WebGPU HDR" | shader não compilou: os pipelines ficam inválidos mas o app segue rodando | o `WGSL error` listado junto |
| `A porta 3000 já está em uso por um servidor que não serve ...` | outro projeto ocupa a porta | peça ao usuário para encerrá-lo; não mate processos por conta própria |
| `Erro de validação da GPU` | bind group, layout de vértice, formato ou uso de textura errados | `createPipelines()` / `rebuildShadowTexture()` / `createPostBindGroups()` em `src/main.js` |
| `@binding(N) ... não tem entrada em mainBindGroupLayout` | binding novo no WGSL sem par no JS | skill `bbc-shader`, seção de bindings |
| `FrameUniforms ocupa X bytes, mas ... Float32Array(Y)` | struct e `uniformData` fora de sincronia | skill `bbc-shader`, seção de uniforms |
| `FrameUniforms ... e FrameView ... têm campos diferentes` | mudou uma struct e esqueceu a outra | as duas ficam em `src/shaders.js` |
| `preset 'X' não tem o(s) campo(s)` | parâmetro novo fora dos 4 presets | `src/quality.js` |
| `lê preset.X, que não existe` | nome de campo errado | `src/quality.js` ou o call site |
| `INSTANCE_LAYERS: mesh/lista '...' não está em ...` | camada nova incompleta | skill `bbc-instancias` |
| `cria mesh com matId N, mas o fsMain não tem ramo` | material novo sem shader | skill `bbc-instancias` |
| `array files` / `zipFiles` diferem dos módulos | módulo novo fora do exportador ZIP | `index.html` (array `files`) **e** `downloadModularZip`/`zipFiles` em `src/main.js` |
| `usa Math.random()` | quebra o determinismo por seed | troque por `rng.next()` / `rng.range()` (`PRNG`) |
| `generateInstances() não é determinístico` | ordem de sorteio depende de algo externo | `src/world.js` |
| `waterDepthAt: não achei ...` (aviso) | fórmula do relevo mudou sem espelhar na água | skill `bbc-terreno`, seção do espelho |
| `captura ... praticamente uniforme` | nada é desenhado | erro anterior na lista, ou câmera/uniforms com NaN |
| `HTTP 404 /...` | arquivo referenciado não existe | caminho no `index.html`, `import` ou `loadTextures()` |

## Regras

- O erro já existia antes da sua mudança? Confirme com `git stash`, rode o
  `verificar.mjs`, depois `git stash pop`. Se existia, **avise o usuário** e não
  conserte por conta própria algo que ninguém pediu.
- Nunca "resolva" um erro apagando a checagem, comentando código que funcionava ou
  trocando o shader por uma versão mais simples sem dizer ao usuário.
- FPS em headless é só referência (a GPU é a mesma, mas a resolução é 1280×720).
  Queda grande em relação à execução anterior no mesmo preset merece investigação.
- Se o script falhar com `Chrome não encontrado`, defina `CHROME_PATH`. Se a porta
  3000 estiver ocupada por outro projeto, peça ao usuário para liberá-la.

## Checklist manual (o que o script não cobre)

Peça ao usuário para conferir no navegador dele quando a tarefa tocar nisso:
movimento com WASD e mouse, áudio (botão de som), download do `.zip`, "Nova
Semente" e comportamento em tela de celular.
