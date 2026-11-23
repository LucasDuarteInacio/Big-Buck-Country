---
name: bbc-captura
description: Captura telas do mundo do Big Buck Country no Chrome headless com câmera, hora do dia, névoa e preset escolhidos. Use para ver o resultado de uma mudança visual (shader, terreno, vegetação, iluminação), comparar antes/depois, investigar um bug visual num ponto específico da ilha ou recapturar as imagens de screenshots/ do README.
argument-hint: "[vista | x,z]"
allowed-tools:
  - read
  - grep
  - glob
permissions:
  allow:
    - Exec(node .devin/skills/)
---

# Capturar telas do mundo

Você não enxerga o navegador do usuário. Este script é o seu olho: gera um PNG que
você abre com a ferramenta de leitura de arquivos.

```bash
node .devin/skills/bbc-captura/scripts/captura.mjs --lista          # vistas prontas
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=partida  # → /tmp/bbc-partida.png
node .devin/skills/bbc-captura/scripts/captura.mjs --vista=todas    # as 7 vistas
```

Vistas prontas: `partida` (rio sul olhando o maciço), `aerea` (ilha inteira),
`macico`, `praia`, `sotobosque`, `entardecer`, `noite`.

## Pose livre

```bash
node .devin/skills/bbc-captura/scripts/captura.mjs --pos=530,667 --altura=1.5 --yaw=-0.6 --pitch=-0.06 --hora=0.4 --nevoa=0.2 --out=/tmp/teste.png
```

| Opção | Significado |
|---|---|
| `--pos=x,z` | metros; origem no centro da ilha, **+x = leste, +z = sul**. A ilha vai de cerca de −1000 a +1000 |
| `--altura=m` | metros acima do chão (0 = a pé; 380 = vista aérea) |
| `--yaw=rad` | para onde olha: `0` = sul (+z), `1.57` = leste (+x), `3.14` = norte, `-1.57` = oeste. Para olhar de A para B: `yaw = atan2(Bx − Ax, Bz − Az)` |
| `--pitch=rad` | `> 0` olha para cima, `< 0` para baixo (limite ±1.42) |
| `--hora=0..1` | `0.1` alvorecer · `0.22` manhã dourada (padrão) · `0.5` meio-dia · `0.8` crepúsculo · `0.95` noite |
| `--nevoa=0..1` | névoa; use `0.05` para vistas distantes, senão a névoa esconde tudo |
| `--qualidade=` | `medium` (mais rápido), `high` (padrão do app), `ultra`, `cinematic` |
| `--out=` | `.png` ou `.jpg` (padrão `/tmp/bbc-<vista>.png`) |
| `--hud` | mantém o painel de controles visível |
| `--largura=` `--altura-tela=` | tamanho da janela (padrão 1280×720) |

Opções de pose podem ser combinadas com `--vista` para alterar só um campo
(ex.: `--vista=macico --hora=0.8`).

Para achar coordenadas (onde fica a praia, um rio, o pico), gere o mapa de cima com
`node .devin/skills/bbc-terreno/scripts/mapa.mjs --sonda=x,z` (skill `bbc-terreno`).

## Comparar antes e depois

1. **Antes de editar**: `... --vista=partida --out=/tmp/antes.png`
2. Faça a mudança.
3. `... --vista=partida --out=/tmp/depois.png` com **as mesmas opções**.
4. Abra os dois arquivos e descreva ao usuário o que mudou. O mundo é determinístico
   (seed 2026): qualquer diferença vem do seu código, exceto nuvens e vento, que
   dependem do tempo decorrido.

Use a vista que mostra o que você mudou: água → `partida`; relevo → `aerea` e
`macico`; areia → `praia`; samambaia/grama → `sotobosque`; céu/estrelas/brilho →
`entardecer` e `noite`.

## Se você não consegue ver imagens

O script imprime, para cada captura, `brilho` (0–255), `contraste` e a cor média de
uma grade 3×3 (de cima para baixo, da esquerda para a direita). Compare os números
de antes e depois: a linha de cima é céu/copa, a de baixo é chão/água. Diga ao
usuário que a conferência foi numérica e peça para ele olhar o arquivo.

## Recapturar as imagens do README

As imagens ficam em `screenshots/*.jpg` (`ilha`, `floresta`, `macico`, `praia`,
`sotobosque`, `entardecer`, `noite`, `hud`). As vistas prontas são enquadramentos
parecidos, **não idênticos** aos originais.

- Só sobrescreva `screenshots/` se o usuário pedir.
- Capture primeiro em `/tmp`, mostre ao usuário, e só então grave com
  `--qualidade=ultra --out=screenshots/<nome>.jpg`.
- `hud.jpg` usa `--vista=partida --hud`.

## Problemas

- `O app não ficou pronto` → rode `node .devin/skills/bbc-verificar/scripts/verificar.mjs` para ver o erro.
- Imagem toda cinza-esverdeada → névoa alta demais para a distância; baixe `--nevoa`.
- Câmera dentro de um tronco ou do chão → mude `--pos` alguns metros ou suba `--altura`.
