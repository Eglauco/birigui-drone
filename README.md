# Birigui Drone — Landing Page

Especialistas em gravação com drone. Começa com um **teste**: seção *hero* em tela cheia
com um **vídeo 360°** controlado pelo **movimento do celular** (giroscópio), reproduzindo
o efeito do app do YouTube — inclusive no **iPhone**.

## Como funciona

Em vez do embed do YouTube (que renderiza 360° achatado no iPhone/Safari), usamos um
**player WebGL próprio**: o vídeo **equiretangular** é mapeado numa esfera por um shader,
e a câmera é controlada por:

- **toque/arraste** na tela (celular e desktop), com **inércia** (flick para girar)
- **rotação automática** lenta quando ocioso

A interação por **toque** é a escolhida (pedido do cliente). O controle por **giroscópio**
está pronto no código, desligado por padrão — para reativá-lo, mude `USE_GYRO = true` em
`js/main.js` (nesse caso, o giroscópio exige HTTPS e 1 toque de permissão no iPhone).

## Estrutura

```
birigui-drone/
├── index.html            # hero 360° (canvas WebGL + vídeo oculto como textura)
├── css/styles.css
├── js/main.js            # player WebGL + giroscópio + arraste + autorrotação
├── dev-server.js         # servidor estático (HTTP Range + HTTPS automático se houver cert)
├── package.json
└── assets/
    ├── alphaville-360.mp4       # original (4K/AV1 — NÃO usado no site)
    └── alphaville-360-web.mp4   # H.264 2048×1024 (usado pelo player)
```

## O vídeo (importante)

- O player carrega `assets/alphaville-360-web.mp4` (constante `VIDEO_SRC` no `js/main.js`).
- ⚠️ **iPhone não decodifica AV1.** O download do YouTube Studio vem em **AV1**, então o
  vídeo precisa ser convertido para **H.264** (senão nem carrega no iOS). Comando usado:

  ```bash
  ffmpeg -i assets/alphaville-360.mp4 -an -vf "scale=2048:1024:flags=lanczos" \
    -c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p -crf 27 -preset medium \
    -movflags +faststart assets/alphaville-360-web.mp4
  ```
  `-movflags +faststart` faz o vídeo começar a tocar antes de baixar tudo. Para trocar o
  vídeo, gere um novo `-web.mp4` equiretangular (proporção 2:1) e atualize `VIDEO_SRC`.

## Como rodar

```bash
npm start
```

Abra **http://localhost:5173**. Arraste com o mouse (ou com o dedo no celular) para girar.

## Testar no celular

Com a interação por **toque**, não é preciso HTTPS — basta abrir o IP da máquina na rede
(o servidor mostra `http://192.168.x.x:5173` ao iniciar). Também funciona por túnel:

```bash
cloudflared tunnel --url http://localhost:5173
```

> Diagnóstico: abra a página com `?debug=1` para ver um painel com o estado do vídeo e da
> interação. (HTTPS + permissão de movimento só são necessários se reativar `USE_GYRO`.)

## Produção

- Mantenha o vídeo em **H.264 + faststart**. Se quiser página mais leve, reduza a resolução
  (ex.: 1600×800) ou use um trecho menor em loop.
- HTTPS é recomendado de qualquer forma, mas só é **obrigatório** se reativar o giroscópio
  (`USE_GYRO = true`), que exige contexto seguro.
