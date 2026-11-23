---
name: bbc-terreno
description: Guia para alterar o relevo e a planta da ilha do Big Buck Country - costa, maciço central, rios, praia, fundo do mar, clareiras e densidade de mata em src/island.js e src/world.js - mantendo o shader de água sincronizado. Inclui um script que desenha o mapa da ilha visto de cima e sonda pontos sem abrir o navegador. Use ao mexer em getTerrainHeight, shoreDist, mountMask, riverMask, forestDensity, ISLAND, ponto de partida, ou quando a água, a praia ou os rios aparecerem no lugar errado.
allowed-tools:
  - read
  - grep
  - glob
permissions:
  allow:
    - Exec(node .devin/skills/)
---

# Relevo e planta da ilha

## Ferramenta: mapa de cima (1 segundo, sem navegador)

```bash
node .devin/skills/bbc-terreno/scripts/mapa.mjs                          # → /tmp/bbc-mapa.png
node .devin/skills/bbc-terreno/scripts/mapa.mjs --arvores                # + pontos das árvores (preset medium)
node .devin/skills/bbc-terreno/scripts/mapa.mjs --sonda=212,313 --sonda=0,0
node .devin/skills/bbc-terreno/scripts/mapa.mjs --seed=777 --out=/tmp/outra.png --res=800
```

Abra o PNG com a ferramenta de leitura de arquivos. Norte em cima; +x para a
direita (leste), +z para baixo (sul). Cores: azul-escuro mar · ciano raso · azul
vivo rio · bege areia · verde-claro campo · verde-escuro mata · cinza rocha ·
branco neve · ponto vermelho câmera inicial · magenta sondas.

A saída em texto serve mesmo sem ver a imagem:

- `terra emersa` (km²), `rios` (ha), altura mín/máx e onde fica o pico.
- `--sonda=x,z`: altura, `shoreDist` (m da costa; negativo = mar), `mountMask`
  (0 mata → 1 maciço), `riverDist`, `riverMask`, `forestDensity`, inclinação.
- `--arvores`: quantas instâncias de cada lista e `árvores colocadas: N de M`. Se
  vier `ABAIXO do pedido`, alguma regra de rejeição ficou restritiva demais.

**Sempre gere o mapa antes e depois** (`--out=/tmp/mapa-antes.png` e
`/tmp/mapa-depois.png`) e compare os números.

## Onde cada coisa é decidida

| O quê | Onde | Observação |
|---|---|---|
| Forma da costa | `ISLAND.coastR0`, `ISLAND.coastHarm` (`island.js`) | série de Fourier polar, em frações de `WORLD_SIZE` |
| Posição e largura do maciço | `ISLAND.mountSpine` | cápsulas `[x, z, raio]` |
| Traçado dos rios | `ISLAND.rivers` | polilinhas **da nascente para a foz**; o último ponto fica além da costa |
| Meandros | `warpX`, `warpZ` (`island.js`) | repetidos à mão em `islandRiver` dentro de `ISLAND_WGSL` |
| Câmera inicial | `computeSpawn` (`island.js`) | usa o rio de índice 4 (sul) |
| Altura | `getTerrainHeight` (`world.js`) | camadas, nesta ordem: chão da mata → maciço → restinga/praia → várzea e leito dos rios → mergulho no mar |
| Largura do rio | `riverCore`, `riverMask` | |
| Onde há mata | `forestDensity` | usada pelas instâncias **e** pela cor do chão |
| Cor do chão, areia, neve | `buildTerrainMesh` | por vértice; areia e campo vão no uv |
| Tamanho do mundo | `WORLD_SIZE` (`island.js`) | **não mude**: ver abaixo |

Tudo em metros, origem no centro. Faixas escritas como fração do mundo
(`S * 0.06`) para acompanhar `worldSize`.

## Regra de ouro: o espelho da água

A água é um plano único em `y = waterLevel`. O shader decide onde é raso, onde há
espuma e a cor do fundo recalculando a altura do terreno em `fn waterDepthAt`
(`shaders.js`). Se o relevo mudar e o espelho não, aparece espuma no seco, linha
d'água torta ou água "funda" sobre banco de areia.

| Mudou em `world.js` / `math.js` | Espelhe em `shaders.js` |
|---|---|
| `shoreDist` | `fn islandShore` |
| fórmula de praia/restinga, várzea, leito do rio ou fundo do mar em `getTerrainHeight` | `fn waterDepthAt` (mesma ordem de camadas) |
| `riverCore`, `mountMask` | as linhas `core`, `mountM`, `dry` de `waterDepthAt` |
| `this.waterLevel` | os `-2.38` de `waterDepthAt` |
| `hash2`, `noise2D`, `fbm` de `ProceduralNoise` | `worldHash`, `worldNoise2D`, `worldFbm3` |
| dados de `ISLAND` (costa, espinha, rios) | **nada**: `ISLAND_WGSL` é gerado dos mesmos dados |
| `warpX`/`warpZ` | o `let q = ...` e as derivadas `wxDz`/`wzDx` em `islandRiver` (`island.js`) |

Como traduzir JS → WGSL:

- O shader não conhece `S`: escreva o valor em metros com `S = 2600`
  (`S * 0.06` → `156.0`, `S * 0.04` → `104.0`).
- `smooth01(a / b)` → `smoothstep(0.0, b, a)`; `smooth01((a - c) / b)` → `smoothstep(c, c + b, a)`.
- `h = h * (1 - w) + alvo * w` → `approxH = mix(approxH, alvo, w);`
- `this.noise.fbm(x * f + ox, z * f + oz, 3)` → `worldFbm3(x * f + ox, z * f + oz)`.
  Só existe a versão de 3 oitavas no shader.
- O chão da mata e o maciço **não** são espelhados (a água nunca chega lá): mudanças
  só neles não exigem tocar no shader.

Por isso `WORLD_SIZE` fica em 2600: mudá-lo exige recalcular todos esses literais.
Se o usuário pedir um mundo maior, avise do custo antes.

O `checar.mjs` avisa quando um literal esperado some de `waterDepthAt`, mas não
prova que as fórmulas batem. A prova é visual: capture a foz e a praia.

## Receitas

**Mudar a costa / o maciço / um rio**: edite só os números de `ISLAND`. Rode o
mapa. Rios precisam começar perto do maciço e terminar além da costa; mantenha a
ordem nascente → foz (o shader usa o sentido para a correnteza). Se mexer no rio
de índice 4, confira a câmera inicial (ponto vermelho no mapa, em terra, na margem).

**Praia mais larga ou mais estreita**: fator `S * 0.06` da restinga em
`getTerrainHeight` → mesmo valor em metros em `plainT` de `waterDepthAt`. A areia
pintada no chão é outra faixa, em `buildTerrainMesh`; e as árvores param em
`shoreDist < S * 0.028` dentro de `generateInstances` — ajuste as três juntas.

**Rio mais largo ou mais fundo**: `riverCore` e o bloco `bedY` em
`getTerrainHeight` → linhas `core` e `bedY` de `waterDepthAt`. O leito precisa
ficar pelo menos 1,2 m abaixo de `waterLevel`, senão a malha fura a água.

**Mais ou menos clareiras**: `forestDensity` (limiar do `glade`). Não exige shader.
Confira `árvores colocadas` no mapa com `--arvores`.

**Montanha mais alta ou mais larga**: multiplicadores de `mountH` em
`getTerrainHeight` e raios em `ISLAND.mountSpine`. A linha das árvores (`y > 14.0`)
e a neve (em `buildTerrainMesh`) são por altitude — reveja se mudar a escala.

## Cuidados

- Instâncias apoiam-se em `getMeshHeight` (a malha como renderizada), não em
  `getTerrainHeight`. Relevo muito recortado numa malha grossa faz objeto flutuar:
  confira no preset `medium` (`terrainRes` menor).
- Nada de `Math.random()`. Ruído novo: `this.noise.fbm(...)` com deslocamentos
  próprios (`+ 11.3`, `- 7.1`) para não repetir o padrão de outra camada.
- `getTerrainHeight` é chamada centenas de milhares de vezes na geração e a cada
  frame pela câmera. Não ponha laços pesados nela; meça o tempo com o mapa
  (`--arvores` imprime os segundos).
- O porte para Godot citado no `AGENTS.md` usa a mesma ilha: se a pasta `godot/`
  existir, avise o usuário que a planta mudou.

## Fechamento

```bash
node .devin/skills/bbc-terreno/scripts/mapa.mjs --arvores --out=/tmp/mapa-depois.png
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=aerea
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=praia
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=partida
node .devin/skills/bbc-verificar/scripts/verificar.mjs
```

Na `partida` e na `praia`, olhe a linha d'água: ela deve encostar na margem, sem
faixa de espuma no seco nem chão aparecendo por cima da água.
