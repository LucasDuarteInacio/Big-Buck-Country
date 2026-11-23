---
name: bbc-instancias
description: Receita para adicionar ou ajustar objetos instanciados do Big Buck Country - nova planta, pedra ou outro objeto espalhado pela ilha, novo material, contagens, regras de onde cada coisa nasce, níveis de detalhe (LOD) e parâmetros de QUALITY_PRESETS. Cobre os pontos que precisam mudar juntos em world.js, quality.js, main.js (rebuildWorld, INSTANCE_LAYERS) e shaders.js. Use ao criar um novo tipo de vegetação ou objeto, mudar densidade ou distribuição, mexer em distâncias de LOD ou adicionar um campo de qualidade.
allowed-tools:
  - read
  - grep
  - glob
permissions:
  allow:
    - Exec(node .devin/skills/)
---

# Objetos instanciados, LOD e presets

## Como funciona (leia uma vez)

- Um **mesh** (forma) é construído uma vez por `build*Mesh()` em `world.js`.
- Uma **lista de instâncias** diz onde cada cópia fica: 8 floats —
  `x, y, z, escala, rotY, fase do vento, tint, peso do vento` (0 = rígido, ~1 = balança).
- O mundo é dividido em `GRID_N × GRID_N` células. Cada instância guarda a sua
  célula; o renderer só desenha as células visíveis e na faixa de distância certa.
- Uma **camada** em `INSTANCE_LAYERS` (`main.js`) liga mesh + lista + pipeline + faixa + sombra.

Faixas de distância (4º campo da camada):

| Faixa | Desenha células... | Usada por |
|---|---|---|
| `near` | até `treeDetailDist` | copa detalhada |
| `mid` | de `treeDetailDist` a `treeLodDist` | copa de cartões |
| `tree` | até `treeLodDist` (near + mid) | troncos, troncos caídos |
| `far` | além de `treeLodDist` | árvore simplificada |
| `under` | até `understoryDist` | samambaia, grama, cogumelo |
| `all` | qualquer distância dentro da tela | rochas |

Pipeline (3º campo): `solid` (face única, objetos fechados) ou `foliage` (dupla
face, cartões de folha). Sombra (5º campo): `true` custa caro — só para o que
projeta sombra visível.

## Ajustar o que já existe

| Quero... | Onde |
|---|---|
| mais/menos de algo | o campo em `QUALITY_PRESETS` (`quality.js`), nos **4** presets, mantendo a ordem crescente medium < high < ultra < cinematic |
| mudar onde nasce | o bloco numerado do objeto em `generateInstances` (`world.js`): `1.` árvores+copas, `2.` samambaias, `3.` grama, `4.` rochas, `5.` troncos caídos+cogumelos, `6.` esporos |
| mudar tamanho/variação | os `rng.range(...)` de escala e tint no `push` do bloco |
| mudar a forma | o `build*Mesh` correspondente |
| ver mais longe / mais perto | `treeDetailDist`, `treeLodDist`, `understoryDist` nos 4 presets |

Depois confira com
`node .devin/skills/bbc-terreno/scripts/mapa.mjs --arvores` (imprime a contagem
real de cada lista e se as árvores pedidas couberam) e o FPS do `verificar.mjs`.

## Adicionar um objeto novo — 6 passos

Exemplo: arbustos (`bush`). Troque os nomes; siga a ordem.

**1. Campo de quantidade** — `src/quality.js`, nos 4 presets:

```js
bushes: 9000,   // medium; aumente em high, ultra, cinematic
```

**2. Mesh** — `src/world.js`, novo método ao lado dos outros `build*Mesh`. Copie o
mais parecido como ponto de partida (`buildRockMesh` para volume fechado,
`buildFernMesh` para cartões de folha) e termine com `packMesh`:

```js
buildBushMesh() {
  const rng = new PRNG(4242);            // seed fixa própria: a forma não muda com o mundo
  const positions = [], normals = [], colors = [], uvs = [], indices = [];
  // ... empurre 3 floats por vértice em positions/normals/colors, 2 em uvs, 3 índices por triângulo
  return this.packMesh(positions, normals, colors, uvs, indices, 3.0);   // matId
}
```

O mesh fica em torno da origem, base em `y = 0`, tamanho de ~1 m (a escala vem da
instância). Reaproveite um `matId` existente sempre que der (3 = folhagem baixa,
4 = rocha, 1 = casca, 9 = madeira): evita mexer no shader.

**3. Instâncias** — `src/world.js`, em `generateInstances`:

```js
const bushes = new InstanceList(preset.bushes);                 // junto das outras listas
```

O bloco de colocação vai **depois do bloco `6. Esporos`** e antes de
`const centerY`. Assim os sorteios novos vêm por último e não mudam a posição de
tudo o que já existe (o `rng` é uma sequência única):

```js
// 7. Arbustos — borda das clareiras
for (let i = preset.bushes * 8; i > 0 && bushes.count < preset.bushes; i--) {
  if (!pickForest(1)) continue;                                 // ponto proporcional à mata
  const x = spot[0], z = spot[1];
  if (this.shoreDist(x, z) < S * 0.028) continue;               // fora da areia
  if (this.riverMask(x, z) > 0.3) continue;                     // fora d'água
  const y = this.getMeshHeight(x, z, res, meshCache);           // altura da malha, não getTerrainHeight
  if (y < -2.1 || y > 12.0) continue;
  bushes.push(cellOf(x, y, z), x, y - 0.03, z, rng.range(0.7, 1.4), rng.range(0, Math.PI * 2), rng.range(0, 100), rng.range(0.85, 1.2), 0.6);
}
```

E registre no objeto `lists`, logo abaixo:

```js
bushes: [bushes, 'bushCount'],
```

**4. Mesh no renderer** — `src/main.js`, objeto `meshes` de `rebuildWorld`:

```js
bush: this.world.buildBushMesh(),
```

**5. Camada** — `src/main.js`, `INSTANCE_LAYERS`. Sólidos ficam junto dos `solid`,
folhagem junto dos `foliage`:

```js
['bush', 'bushes', 'foliage', 'under', false],
```

**6. Conferir**

```bash
node .devin/skills/bbc-verificar/scripts/checar.mjs      # acusa mesh/lista/preset faltando
node .devin/skills/bbc-terreno/scripts/mapa.mjs --arvores  # a lista nova aparece com a contagem
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=sotobosque
node .devin/skills/bbc-verificar/scripts/verificar.mjs
```

Não é preciso tocar em `uploadScene`, `selectCells` nem `drawLayer`: eles leem
`INSTANCE_LAYERS`. O exportador ZIP também não muda (nenhum arquivo novo).

## Material novo (só se nenhum existente servir)

1. Escolha o próximo número livre (hoje 0–9 estão em uso; confirme com
   `grep -n "mat == " src/shaders.js`) e use-o no `packMesh`.
2. Atualize o comentário `// Material IDs:` acima de `buildTerrainMesh`.
3. `shaders.js`, `fsMain`: novo ramo `} else if (mat == 10) {` definindo `albedo`,
   `roughness` e, se quiser, `ao`/`emissive`. Copie o ramo da rocha (`mat == 4`)
   como base.
4. Procure as outras listas de materiais e decida se o novo entra em cada uma:
   `grep -n "mat == 2 ||" src/shaders.js` (iluminação de dupla face, translucidez
   de folha) e `in.matId > 2.5 && in.matId < 3.5` em `vsInstanced` (encolhimento do
   sub-bosque no limite do alcance — só vale para o material 3).
5. Folha com recorte precisa também de `fsShadowClip`.
6. Siga o skill `bbc-shader` para validar.

## Parâmetro de qualidade novo

1. Adicione o campo aos **4** presets de `quality.js`.
2. Leia como `preset.campo` em `world.js` (geração) ou `main.js` (render).
3. Se o shader precisa do valor, ele viaja num uniform — skill `bbc-shader`.
4. Nunca escreva o número direto em `main.js`/`world.js`.

`autoScale`/`renderScale` não são preset: são o governador de FPS em runtime.

## Nível de detalhe distante para um objeto

Padrão das árvores: o mesmo `build*Mesh(variante, lod)` devolve versões mais
leves, e duas camadas usam **a mesma lista** com faixas diferentes (`near` + `mid`,
ou `tree` + `far`). Faixas que se sobrepõem desenham o objeto duas vezes — escolha
faixas complementares.

## Cuidados

- `Math.random()` é proibido aqui. Só `rng` (`PRNG` com a seed do mundo).
- Sempre `cellOf(x, y, z)` no `push`: sem a célula certa o objeto some por culling.
- Objetos altos ou largos (mais de ~20 m acima do chão ou ~13 m além da célula)
  saem da esfera de culling calculada em `centerY`/`radius` e piscam na borda da tela.
- Contagens são da ilha inteira. Centenas de milhares de instâncias na faixa
  `under` são normais; na faixa `all`, não — custam em toda distância.
- Laço de colocação sempre com limite de tentativas (`preset.x * 8`), nunca `while (true)`.
