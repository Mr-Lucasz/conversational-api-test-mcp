# Vídeo "Postman → MCP" no After Effects

`postman-run.jsx` monta no After Effects o mesmo vídeo da composição Remotion `PostmanRun`
(`src/PostmanRun.tsx`): a collection `demo/blog-api.postman_collection.json` importada pelo MCP
e executada inteira, 8/8, numa única chamada de `execute_api_flow`. Os números na tela vêm
dessa execução real, e a narração (ElevenLabs, voz Cristian PT-BR) entra no início de cada cena.

## Como rodar

1. Instale as fontes **IBM Plex Sans** e **IBM Plex Mono** (Google Fonts). Sem elas o AE usa
   outra fonte e o script avisa no final.
2. No After Effects: **File > Scripts > Run Script File…** e escolha `postman-run.jsx`.
   Deixe o arquivo nesta pasta: ele busca a narração, a música e os efeitos em `../public/audio`.
3. A comp `PostmanRun` abre no viewer. Tudo fica num único passo de undo (Ctrl+Z desfaz).

Para versões antigas do AE (anteriores à 16.0), troque o motor de expressões para JavaScript
em **File > Project Settings > Expressions**; o script tenta fazer isso sozinho.

## O que o script cria

| Item | Detalhe |
| --- | --- |
| Comp `PostmanRun` | 1080×1350 (4:5), 30 fps, 64 s, um marcador por cena |
| Pasta `cenas` | 6 precomps: intro, collection, prompt, run, result, outro |
| Null `RIG` | Sliders `Wiggle Freq`, `Wiggle Amp`, `Bounce Amp`, `Bounce Freq`, `Bounce Decay` |
| Comp `Audio` | Narração `vo-pm-*.mp3` (+2 dB, 8 frames após cada corte), música a −20 dB e os efeitos (tick, typing, chime, whoosh) no tempo de cada evento |
| Moldura | Cabeçalho, contador de cena `01 / 06` e barra de progresso, todos por expressão |

Para ajustar a intensidade de todos os bounces ou do tremor de uma vez, mexa nos sliders do
`RIG`. Se renomear a comp `PostmanRun`, atualize `comp("PostmanRun")` nas expressões.

## Expressões

Todas usam o motor JavaScript do AE. Ele **não soma arrays com `+`**: use `add()`, `sub()` e
`mul()`, como abaixo.

### Bounce (escala dos checks)

Overshoot amortecido depois do último keyframe. Anime de 0 a 100% e aplique em Scale:

```js
var rig = comp("PostmanRun").layer("RIG");
var amp = rig.effect("Bounce Amp")("Slider");      // 0.05
var freq = rig.effect("Bounce Freq")("Slider");    // 2.5
var decay = rig.effect("Bounce Decay")("Slider");  // 7
var n = 0;
if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }
var t = n > 0 ? time - key(n).time : 0;
if (n > 0 && t < 2) {
  var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);
  add(value, mul(v, amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t)));
} else {
  value;
}
```

### Wiggle com janela (tremor do 8/8)

Treme só a partir de `hit` e morre em `len` segundos. Fica no null `SHAKE`, pai do check e do
número:

```js
var rig = comp("PostmanRun").layer("RIG");
var freq = rig.effect("Wiggle Freq")("Slider");
var amp = rig.effect("Wiggle Amp")("Slider");
var hit = 1.8333, len = 0.8;
var gate = time < hit ? 0 : ease(time, hit, hit + len, 1, 0);
add(value, mul(sub(wiggle(freq, amp), value), gate));
```

### Contador (ms e 0 → 8)

Em Source Text. Formata milhar no padrão pt-BR (`1.543 ms`):

```js
function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
fmt(linear(time, 4.2667, 8.7667, 0, 1543)) + " ms";
```

### Passos concluídos e cor que muda no fim

Source Text conta quantos carimbos já passaram; a mesma lógica no efeito **Fill** troca a cor
para verde quando os 8 passam:

```js
var stamps = [4.8, 5.3667, 5.9333, 6.5, 7.0667, 7.6333, 8.2, 8.7667];
var n = 0;
for (var i = 0; i < stamps.length; i++) { if (time >= stamps[i]) n++; }
n >= stamps.length ? [0.373, 0.796, 0.525, 1] : [0.929, 0.922, 0.894, 1];
```

### Máquina de escrever

Em Source Text. Quebra a linha onde você quiser e pisca o cursor quando termina:

```js
var lines = ["importa a collection do Blog API", "e roda tudo"];
var full = lines.join("\r");
var n = Math.max(0, Math.floor((time - 3) * 20));
var typing = n < full.length;
var cursor = (typing || Math.floor(time * 2) % 2 === 0) ? "_" : " ";
"> " + full.substr(0, n) + cursor;
```

### Loops

Cursor piscando: três keyframes HOLD em Opacity (100, 0, 100) repetidos para sempre:

```js
time < key(1).time ? 0 : loopOut("cycle");
```

Ponto "rodando": dois keyframes (100 → 25) indo e voltando até o último passo terminar:

```js
time > 8.7667 ? 0 : loopOut("pingpong");
```

### Moldura

Contador de cena a partir dos marcadores da comp (Source Text):

```js
var m = thisComp.marker, s = 1;
for (var i = 1; i <= m.numKeys; i++) { if (time >= m.key(i).time) s = i; }
function pad(n) { return (n < 10 ? "0" : "") + n; }
pad(s) + " / " + pad(m.numKeys);
```

Barra de progresso (Scale de um retângulo com âncora na borda esquerda):

```js
[linear(time, 0, thisComp.duration - thisComp.frameDuration, 0, 100), 100];
```

## Versão Remotion

A mesma peça renderiza sem After Effects:

```bash
npm run render:postman
```

Saída: `out/postman-run.mp4`.