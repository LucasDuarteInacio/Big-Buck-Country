---
name: bbc-shader
description: Guia para editar os shaders WGSL do Big Buck Country em src/shaders.js sem quebrar o pipeline - erros comuns de WGSL, como adicionar ou reaproveitar um uniform, como adicionar binding ou textura, estrutura do fsMain por material, pós-processamento (god rays, SSAO, bloom) e como achar a linha de um erro do Tint. Use ao alterar cor, iluminação, materiais, água, céu, nuvens, névoa, sombras ou pós-processamento, e ao depurar erros "Tint WGSL" ou "validation error".
allowed-tools:
  - read
  - grep
  - glob
permissions:
  allow:
    - Exec(node .devin/skills/)
---

# Editar shaders WGSL

O WGSL vive em dois template literals de `src/shaders.js`:

- `WGSL_SHADERS` — sombra, terreno, instâncias, `fsMain`, céu, esporos.
- `WGSL_POST_SHADERS` — god rays, SSAO, bloom, composite.

`node --check` **não** valida WGSL. O único jeito de saber se compila:

```bash
node .devin/skills/bbc-verificar/scripts/verificar.mjs
```

Ele imprime o erro do compilador com o texto da linha culpada e a linha
correspondente em `src/shaders.js`. Rode depois de **cada** mudança de shader, não
só no fim: um erro por vez é fácil; cinco juntos, não.

## Método

1. Capture o "antes": `node .devin/skills/bbc-captura/scripts/captura.mjs --vista=partida --out=/tmp/antes.png`
2. Ache o trecho: `grep -n "fn nomeDaFuncao\|mat == 6" src/shaders.js` e leia só ele.
3. Mude **uma** coisa pequena.
4. `verificar.mjs`. Erro? Conserte antes de seguir.
5. Capture o "depois" com as mesmas opções e compare.

## Erros de WGSL que mais acontecem

| Errado | Certo | Por quê |
|---|---|---|
| `` ` `` ou `${` dentro do shader | nunca use | está dentro de um template literal JavaScript |
| `let x = 1.0; x = 2.0;` | `var x = 1.0; x = 2.0;` | `let` é imutável |
| `cond ? a : b` | `select(b, a, cond)` | não existe ternário; a ordem é (falso, verdadeiro, condição) |
| `v.xy = vec2<f32>(...)` | `v = vec3<f32>(novo.x, novo.y, v.z)` ou `v.x = ...; v.y = ...;` | não se atribui a swizzle |
| `f32 * i32` com variáveis | `x * f32(i)` | não há conversão implícita entre variáveis |
| `float`, `vec3`, `mix(a,b,0)` com vetor inteiro | `f32`, `vec3<f32>`, literais com ponto (`0.0`) | tipos sempre explícitos |
| `textureSample(...)` dentro de `if`/laço no fragment | `textureSampleLevel(t, s, uv, 0.0)` ou a função `texLin(t, uv)` | derivadas só valem em fluxo uniforme; `texLin` já resolve |
| `pow(x, y)` com `x < 0` | `pow(max(x, 0.0), y)` | resultado indefinido vira NaN (pixels pretos) |
| `normalize(vec3<f32>(0.0))`, divisão por zero | some um epsilon | NaN |
| `smoothstep(a, b, x)` com `a >= b` | garanta `a < b` (inverta com `1.0 - smoothstep(...)`) | indefinido |
| declarar a mesma `fn`/variável duas vezes | nome único por módulo | os dois módulos são independentes, mas dentro de cada um não pode repetir |
| usar função antes de existir no **outro** módulo | copie para o módulo certo | `WGSL_SHADERS` e `WGSL_POST_SHADERS` não compartilham nada |

## Estrutura do `fsMain`

`let mat = i32(in.matId + 0.5);` e depois uma cadeia `if (mat == 0) {...} else if (...)`.
Cada ramo define `albedo`, `roughness`, `metallic`, `ao`, `emissive` e o relevo
(`bump`). Depois vêm, comuns a todos: sombra, Cook-Torrance, ambiente, o bloco
especial da água (`if (mat == 6)`), névoa.

| mat | O quê | mat | O quê |
|---|---|---|---|
| 0 | terreno (areia e campo vêm em `in.uv.x` e `in.uv.y`) | 5 | cogumelo (emissivo) |
| 1, 8 | casca A / casca B | 6 | água |
| 2, 7 | folha lanceolada / redonda (recorte por `leafSilhouette*`) | 9 | tronco caído |
| 3 | samambaia e grama | 4 | rocha |

Mudar só um material? Edite só o ramo dele. Não mexa no bloco comum sem precisar:
ele afeta a cena inteira.

## Uniforms por frame

Um buffer só, lido como `frame` (principal) e `frame2` (pós). 80 floats = 320 bytes.
Preenchido no fim de `loop()` em `src/main.js` (`grep -n "u\[48\]" src/main.js`).

| Campo WGSL | Índices `u[...]` | Conteúdo |
|---|---|---|
| `viewProj` | 0–15 | matriz câmera |
| `invViewProj` | 16–31 | inversa |
| `lightViewProj` | 32–47 | matriz do sol (sombra) |
| `cameraPos` | 48–51 | xyz posição · **w = seed do mundo** |
| `sunDir` | 52–55 | xyz direção · **w = alcance do sub-bosque (m)** |
| `sunColor` | 56–59 | rgb · w livre (hoje 1.0) |
| `skyTopColor` | 60–63 | rgb · w livre |
| `skyHorizonColor` | 64–67 | rgb · w livre |
| `fogColor` | 68–71 | rgb · w livre |
| `params` | 72–75 | tempo (s), vento, névoa, elevação do sol |
| `params2` | 76–79 | passos de god ray, limiar de bloom, bias de sombra, aspecto |

### Preciso passar um valor novo ao shader

**Caminho fácil — reaproveitar um `.w` livre** (não muda tamanho nenhum):

1. Em `main.js`, troque o `1.0` do slot, por exemplo `u[59] = this.meuValor;`, e
   comente o significado na mesma linha, como os vizinhos.
2. Em `shaders.js`, atualize o comentário do campo nas **duas** structs e leia
   `frame.sunColor.w` (ou `frame2.sunColor.w` no pós).
3. Antes, confirme que o slot não é lido: `grep -n "sunColor.w" src/shaders.js`.

**Caminho completo — os 4 slots livres acabaram:**

1. Acrescente `params3: vec4<f32>,` ao **final** de `FrameUniforms` **e** de `FrameView`.
2. `main.js`: `new Float32Array(80)` → `84`; escreva `u[80]`…`u[83]`.
3. O `uniformBuffer` tem 512 bytes; só aumente se passar disso.
4. Use só `vec4<f32>` e `mat4x4<f32>` na struct. `f32`, `vec2` e `vec3` soltos criam
   padding e deslocam tudo.

Se o valor vem de qualidade gráfica, ele nasce em `QUALITY_PRESETS` (nos 4 presets)
e é copiado para `u[...]` — nunca um número fixo em `main.js`.

## Bindings e texturas

Grupo 0 do pipeline principal: 0 uniforms · 1 shadow map · 2 sampler de comparação ·
3–7 e 9–15 texturas · 8 sampler das texturas. Pós: 0 `post` · 1 `srcTex` · 2 `bloomTex`
· 3 sampler · 4 depth · 5 `frame2` · 6–7 shadow map.

Para adicionar uma textura (4 lugares, todos obrigatórios):

1. Arquivo em `textures/` e nome no array de `loadTextures()` (`main.js`). Licença:
   os assets atuais são CC BY-NC-SA 3.0 do Shadertoy — confirme a licença do novo
   com o usuário.
2. Mesmo nome na lista de texturas do exportador ZIP em `bindUI()`.
3. `createPipelines()`: nova linha em `mainBindGroupLayout` com o próximo número
   (`texture: { sampleType: 'float' }`), e nova entrada em `rebuildShadowTexture()`
   apontando para `this.textureViews[índice no array]`.
4. `shaders.js`: `@group(0) @binding(N) var texNome: texture_2d<f32>;` e amostre com
   `texLin(texNome, uv)` (já converte sRGB → linear).

O limite padrão do WebGPU é 16 texturas amostradas por estágio; o projeto usa 13
(12 fotos + shadow map). Passando disso, junte texturas num atlas em vez de pedir
limites maiores.

## Pós-processamento

- God rays e SSAO rodam **no pós**, não no `fsMain`.
- O SSAO é calculado em meia resolução em `fsBloomExtract` e viaja no **canal alpha
  do bloom**; `fsComposite` lê `bloom.a`. Não escreva outra coisa nesse alpha.
- `PostUniforms` (32 bytes): `direction` (blur), `threshold`, `bloomIntensity` —
  valores em `createPipelines()` (`postUniformH`/`postUniformV`).
- Trocar a resolução do shadow map recria os bind groups de pós (`createPostBindGroups`).

## Espelhos JS ↔ WGSL (não edite um lado só)

`waterDepthAt`, `islandShore`, `worldHash`/`worldNoise2D`/`worldFbm3` reproduzem
funções de `world.js`/`math.js` para a água saber onde é raso. As funções `island*`
são **geradas** por `ISLAND_WGSL` em `src/island.js`. Detalhes no skill `bbc-terreno`.

## Desempenho

- `fsSky` é o fragment mais caro e é desenhado depois dos opacos de propósito. Não mude a ordem.
- Laços com contagem vinda de preset (`godRaySteps`): não fixe o número no shader.
- Ruído (`fbm3`, `fbm5`) por pixel custa caro: prefira a versão com menos oitavas e
  calcule uma vez, guardando em `let`.
- Depois de mudanças pesadas, compare o FPS impresso pelo `verificar.mjs` com o de antes.

## Se travar

Três tentativas sem compilar? Desfaça (`git diff src/shaders.js` para ver, `git
checkout src/shaders.js` **só com permissão do usuário**, pois apaga o trabalho
dele também) e refaça em passos menores, ou explique ao usuário onde travou.
