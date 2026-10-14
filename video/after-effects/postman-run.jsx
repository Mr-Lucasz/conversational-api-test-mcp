// postman-run.jsx  -  After Effects: File > Scripts > Run Script File...
//
// Monta, do zero, o video "Postman -> MCP": a collection Blog API importada pelo
// conversational-api-test-mcp e executada inteira (8/8) numa chamada de execute_api_flow.
// E a versao After Effects da composicao Remotion src/PostmanRun.tsx, com os mesmos
// tempos (30 fps), cores e dados da execucao real.
//
// Cria: pasta de projeto, comp principal "PostmanRun" (1080x1350, 64 s), uma precomp por
// cena, camadas de texto e shape, keyframes com easing, marcadores por cena, audio
// (narracao ElevenLabs, musica e efeitos de video/public/audio) e um null "RIG" com sliders que controlam
// as expressoes de wiggle e bounce.
//
// Fontes: IBM Plex Sans e IBM Plex Mono (Google Fonts). Sem elas o AE substitui e avisa.
(function () {
    var FPS = 30, W = 1080, H = 1350, PAD = 72, CONTENT = W - 2 * PAD;
    var MAIN = "PostmanRun", RIG = "RIG";
    var RIG_REF = 'comp("' + MAIN + '").layer("' + RIG + '")';

    var C = { bg: "0F100D", ink: "EDEBE4", muted: "9A978C", rule: "2E2F29", accent: "F2B33D", pass: "5FCB86" };
    var FONT = {
        sans: "IBMPlexSans", sansSemi: "IBMPlexSans-SemiBold", sansBold: "IBMPlexSans-Bold",
        mono: "IBMPlexMono", monoSemi: "IBMPlexMono-SemiBold"
    };

    // Execucao real: video/demo/blog-api.postman_collection.json contra o JSONPlaceholder.
    var RUN = [
        { folder: "Posts", name: "List posts", method: "GET", path: "/posts", status: 200, ms: 127 },
        { folder: "Posts", name: "Get post", method: "GET", path: "/posts/1", status: 200, ms: 43 },
        { folder: "Posts", name: "Create post", method: "POST", path: "/posts", status: 201, ms: 211 },
        { folder: "Posts", name: "Update post", method: "PUT", path: "/posts/1", status: 200, ms: 458 },
        { folder: "Posts", name: "Patch post title", method: "PATCH", path: "/posts/1", status: 200, ms: 157 },
        { folder: "Posts", name: "Delete post", method: "DELETE", path: "/posts/1", status: 200, ms: 191 },
        { folder: "Comments", name: "Comments of post", method: "GET", path: "/comments?postId=1", status: 200, ms: 292 },
        { folder: "Users", name: "Get user", method: "GET", path: "/users/1", status: 200, ms: 64 }
    ];
    var TOTAL_MS = 0, MAX_MS = 0;
    for (var runIndex = 0; runIndex < RUN.length; runIndex++) {
        TOTAL_MS += RUN[runIndex].ms;
        if (RUN[runIndex].ms > MAX_MS) { MAX_MS = RUN[runIndex].ms; }
    }

    // Mesmos tempos da versao Remotion (frames a 30 fps), medidos pela narracao vo-pm-*.mp3.
    var SCENES = [
        { id: "intro", label: "Postman \u2192 MCP", frames: 249, build: buildIntro },
        { id: "collection", label: "A collection", frames: 379, build: buildCollection },
        { id: "prompt", label: "Uma frase no chat", frames: 398, build: buildPrompt },
        { id: "run", label: "execute_api_flow", frames: 453, build: buildRun },
        { id: "result", label: "Resultado", frames: 220, build: buildResult },
        { id: "outro", label: "Open source \u00B7 MIT", frames: 225, build: buildOutro, hold: true }
    ];

    // A narracao de cada cena comeca VO_START frames depois do corte.
    var VO_START = 8;

    var SFX = [];
    var fontWarnings = {};

    // ---------- utilitarios ----------

    function f(frames) { return frames / FPS; }

    function rgb(hex) {
        return [parseInt(hex.substr(0, 2), 16) / 255, parseInt(hex.substr(2, 2), 16) / 255, parseInt(hex.substr(4, 2), 16) / 255];
    }

    function tr(layer) { return layer.property("ADBE Transform Group"); }
    function pos(layer) { return tr(layer).property("ADBE Position"); }
    function op(layer) { return tr(layer).property("ADBE Opacity"); }
    function scl(layer) { return tr(layer).property("ADBE Scale"); }
    function sourceText(layer) { return layer.property("ADBE Text Properties").property("ADBE Text Document"); }

    // Easy ease em todos os keyframes (`influence` em %).
    function easeAll(prop, influence) {
        var inf = influence || 80, dims = 1, e = [], k, i;
        if (!prop.isSpatial && prop.value instanceof Array) { dims = prop.value.length; }
        for (i = 0; i < dims; i++) { e.push(new KeyframeEase(0, inf)); }
        for (k = 1; k <= prop.numKeys; k++) { prop.setTemporalEaseAtKey(k, e, e); }
    }

    // Texto de ponto. Alinhado a esquerda (ou a direita com `right`), ancorado na linha de base.
    function text(comp, str, o) {
        var layer = comp.layers.addText(str);
        var prop = sourceText(layer);
        var doc = prop.value;
        doc.resetCharStyle();
        doc.resetParagraphStyle();
        doc.font = o.font || FONT.sans;
        doc.fontSize = o.size || 40;
        doc.applyFill = true;
        doc.fillColor = rgb(o.color || C.ink);
        doc.applyStroke = false;
        doc.tracking = o.tracking || 0;
        doc.justification = o.right ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY;
        if (o.leading) { doc.autoLeading = false; doc.leading = o.leading; }
        prop.setValue(doc);
        if (prop.value.font !== (o.font || FONT.sans)) { fontWarnings[o.font || FONT.sans] = true; }
        pos(layer).setValue([o.x, o.y]);
        layer.name = o.name || str.split("\r")[0].substr(0, 30);
        return layer;
    }

    // Retangulo preenchido com o canto superior esquerdo em (x, y); a escala X cresce da esquerda.
    function rect(comp, x, y, w, h, color, name) {
        var layer = comp.layers.addShape();
        layer.name = name || "rect";
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        var items = group.property("ADBE Vectors Group");
        var r = items.addProperty("ADBE Vector Shape - Rect");
        r.property("ADBE Vector Rect Size").setValue([w, h]);
        r.property("ADBE Vector Rect Position").setValue([w / 2, h / 2]);
        items.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue(rgb(color));
        tr(layer).property("ADBE Anchor Point").setValue([0, 0]);
        pos(layer).setValue([x, y]);
        return layer;
    }

    // Circulo com check desenhado por Trim Paths. Retorna a camada, o End do trim e a escala base.
    function checkIcon(comp, x, y, size, name) {
        var layer = comp.layers.addShape();
        layer.name = name || "check";
        var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        var items = group.property("ADBE Vectors Group");
        items.addProperty("ADBE Vector Shape - Ellipse").property("ADBE Vector Ellipse Size").setValue([58, 58]);
        var tick = new Shape();
        tick.vertices = [[-13, 1], [-4, 10], [14, -9]];
        tick.closed = false;
        items.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape").setValue(tick);
        var trim = items.addProperty("ADBE Vector Filter - Trim");
        var stroke = items.addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("ADBE Vector Stroke Color").setValue(rgb(C.pass));
        stroke.property("ADBE Vector Stroke Width").setValue(5);
        stroke.property("ADBE Vector Stroke Line Cap").setValue(2);
        tr(layer).property("ADBE Anchor Point").setValue([0, 0]);
        pos(layer).setValue([x, y]);
        var s = size / 64 * 100;
        scl(layer).setValue([s, s]);
        return { layer: layer, end: trim.property("ADBE Vector Trim End"), size: s };
    }

    // Sobe `dy` px e aparece a partir de `t` (segundos).
    function rise(layer, t, dy) {
        var d = dy === undefined ? 28 : dy;
        var o = op(layer), p = pos(layer), v = p.value;
        o.setValueAtTime(t, 0);
        o.setValueAtTime(t + 0.5, 100);
        p.setValueAtTime(t, [v[0], v[1] + d]);
        p.setValueAtTime(t + 0.6, v);
        easeAll(o, 70);
        easeAll(p, 85);
    }

    // Entra deslizando da esquerda.
    function slideIn(layer, t) {
        var o = op(layer), p = pos(layer), v = p.value;
        o.setValueAtTime(t, 0);
        o.setValueAtTime(t + 0.45, 100);
        p.setValueAtTime(t, [v[0] - 30, v[1]]);
        p.setValueAtTime(t + 0.55, v);
        easeAll(o, 70);
        easeAll(p, 85);
    }

    function fadeIn(layer, t, dur) {
        var o = op(layer);
        o.setValueAtTime(t, 0);
        o.setValueAtTime(t + (dur || 0.3), 100);
        easeAll(o, 60);
    }

    // Escala 0 -> `full`% em `t`, com a expressao de bounce depois do ultimo keyframe.
    function pop(layer, t, full) {
        var s = scl(layer), v = full || 100;
        s.setValueAtTime(t, [0, 0]);
        s.setValueAtTime(t + 0.25, [v, v]);
        easeAll(s, 50);
        s.expression = EXPR.bounce;
    }

    // Agenda um efeito sonoro (tempo absoluto na comp principal).
    function sfx(name, sceneStart, frame, db) {
        SFX.push({ file: "sfx-" + name + ".mp3", t: sceneStart + f(frame), db: db === undefined ? -6 : db });
    }

    // Agenda a narracao da cena (video/public/audio/vo-pm-<id>.mp3).
    function vo(id, sceneStart) {
        SFX.push({ file: "vo-pm-" + id + ".mp3", t: sceneStart + f(VO_START), db: 2 });
    }

    function methodColor(m) { return m === "GET" ? C.muted : C.ink; }

    function toSource(arr) {
        var out = [];
        for (var i = 0; i < arr.length; i++) { out.push("\"" + arr[i].replace(/"/g, "\\\"") + "\""); }
        return "[" + out.join(", ") + "]";
    }

    // ---------- expressoes ----------
    // O motor JavaScript do AE nao soma arrays com "+": use add(), sub() e mul().

    var EXPR = {
        // Overshoot amortecido depois do ultimo keyframe. Sliders no null RIG.
        bounce: [
            "var rig = " + RIG_REF + ";",
            "var amp = rig.effect(\"Bounce Amp\")(\"Slider\");",
            "var freq = rig.effect(\"Bounce Freq\")(\"Slider\");",
            "var decay = rig.effect(\"Bounce Decay\")(\"Slider\");",
            "var n = 0;",
            "if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }",
            "var t = n > 0 ? time - key(n).time : 0;",
            "if (n > 0 && t < 2) {",
            "  var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);",
            "  add(value, mul(v, amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t)));",
            "} else {",
            "  value;",
            "}"
        ].join("\n"),

        // Wiggle que so acontece numa janela curta a partir de `hit` (segundos) e morre em `len`.
        gatedWiggle: function (hit, len) {
            return [
                "var rig = " + RIG_REF + ";",
                "var freq = rig.effect(\"Wiggle Freq\")(\"Slider\");",
                "var amp = rig.effect(\"Wiggle Amp\")(\"Slider\");",
                "var hit = " + hit + ", len = " + len + ";",
                "var gate = time < hit ? 0 : ease(time, hit, hit + len, 1, 0);",
                "add(value, mul(sub(wiggle(freq, amp), value), gate));"
            ].join("\n");
        },

        // Contador inteiro de `from` a `to` entre t0 e t1, com separador de milhar pt-BR e sufixo.
        counter: function (t0, t1, from, to, suffix) {
            return [
                "function fmt(n) { return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, \".\"); }",
                "fmt(linear(time, " + t0 + ", " + t1 + ", " + from + ", " + to + ")) + \"" + (suffix || "") + "\";"
            ].join("\n");
        },

        // Prefixo: quantos passos ja carimbaram (instantes em segundos) -> variavel n.
        stepsDone: function (stamps) {
            return "var stamps = [" + stamps.join(", ") + "];\n" +
                "var n = 0;\nfor (var i = 0; i < stamps.length; i++) { if (time >= stamps[i]) n++; }\n";
        },

        // Maquina de escrever com quebra de linha manual e cursor piscando.
        typewriter: function (lines, start, cps) {
            return [
                "var lines = " + toSource(lines) + ";",
                "var full = lines.join(\"\\r\");",
                "var n = Math.max(0, Math.floor((time - " + start + ") * " + cps + "));",
                "var typing = n < full.length;",
                "var cursor = (typing || Math.floor(time * 2) % 2 === 0) ? \"_\" : \" \";",
                "\"> \" + full.substr(0, n) + cursor;"
            ].join("\n");
        },

        // Contador de cena (01 / 06) a partir dos marcadores da comp principal.
        step: [
            "var m = thisComp.marker, s = 1;",
            "for (var i = 1; i <= m.numKeys; i++) { if (time >= m.key(i).time) s = i; }",
            "function pad(n) { return (n < 10 ? \"0\" : \"\") + n; }",
            "pad(s) + \" / \" + pad(m.numKeys);"
        ].join("\n"),

        // Barra de progresso do video inteiro (escala X).
        progress: "[linear(time, 0, thisComp.duration - thisComp.frameDuration, 0, 100), 100];"
    };

    // ---------- cenas ----------

    function sceneChrome(sc, label, labelY) {
        var lb = text(sc, label.toUpperCase(), { font: FONT.mono, size: 30, color: C.accent, tracking: 100, x: PAD, y: labelY, name: "label" });
        rise(lb, 0, 12);
        var wipe = rect(sc, 0, 0, 6, H, C.accent, "wipe");
        var p = pos(wipe);
        p.setValueAtTime(0, [0, 0]);
        p.setValueAtTime(f(16), [W, 0]);
        easeAll(p, 60);
        var o = op(wipe);
        o.setValueAtTime(0, 0);
        o.setValueAtTime(f(4), 100);
        o.setValueAtTime(f(12), 100);
        o.setValueAtTime(f(16), 0);
    }

    function buildIntro(sc, start) {
        sceneChrome(sc, SCENES[0].label, 330);
        rise(text(sc, "Sua collection do\rPostman.", { font: FONT.sansBold, size: 92, leading: 100, x: PAD, y: 440 }), f(6));
        rise(text(sc, "Rodando inteira,\rdentro do agente.", { font: FONT.sansBold, size: 92, leading: 100, color: C.accent, x: PAD, y: 640 }), f(158));
        sfx("tick", start, 158, -3);
        rise(rect(sc, PAD, 790, CONTENT, 2, C.rule, "rule"), f(194));
        rise(text(sc, "Sem abrir o Postman. Sem Newman.\rUma frase no chat.", { size: 40, leading: 54, color: C.muted, x: PAD, y: 860 }), f(194));
    }

    function buildCollection(sc, start) {
        sceneChrome(sc, SCENES[1].label, 230);
        rise(text(sc, "video/demo/blog-api.postman_collection.json", { font: FONT.mono, size: 28, color: C.muted, x: PAD, y: 290 }), f(4));
        rise(text(sc, "Blog API", { font: FONT.sansBold, size: 64, x: PAD, y: 370 }), f(4));
        rise(rect(sc, PAD, 400, CONTENT, 2, C.rule, "rule"), f(4));

        var y = 460, row = 0, last = "", i, r, at;
        for (i = 0; i < RUN.length; i++) {
            r = RUN[i];
            if (r.folder !== last) {
                at = f(18 + row * 12);
                slideIn(text(sc, "\u25BE " + r.folder, { font: FONT.mono, size: 30, color: C.accent, x: PAD, y: y + 10 }), at);
                y += 50;
                row++;
                last = r.folder;
            }
            at = f(18 + row * 12);
            slideIn(text(sc, r.method, { font: FONT.monoSemi, size: 30, color: methodColor(r.method), x: PAD + 36, y: y }), at);
            slideIn(text(sc, r.name, { size: 38, x: PAD + 36 + 141, y: y }), at);
            y += 54;
            row++;
        }
        sfx("tick", start, 18, -8);
        rise(rect(sc, PAD, y + 4, CONTENT, 2, C.rule, "rule"), f(255));
        rise(text(sc, "8 requests \u00B7 3 pastas \u00B7 host em {{baseUrl}}", { font: FONT.mono, size: 30, color: C.muted, x: PAD, y: y + 60 }), f(255));
    }

    function buildPrompt(sc, start) {
        sceneChrome(sc, SCENES[2].label, 360);
        rise(text(sc, "voc\u00EA", { font: FONT.mono, size: 28, color: C.muted, x: PAD, y: 420 }), f(4));
        var typed = text(sc, "> ", { font: FONT.mono, size: 44, leading: 60, x: PAD, y: 490, name: "prompt (typewriter)" });
        sourceText(typed).expression = EXPR.typewriter(["importa a collection do Blog API", "e roda tudo"], f(90), 20);
        fadeIn(typed, f(4), 0.2);
        sfx("typing", start, 90, -7);
        sfx("typing", start, 120, -7);

        rise(rect(sc, PAD, 620, CONTENT, 2, C.rule, "rule"), f(160));
        rise(text(sc, "\u25B8 convert_legacy_to_canonical", { font: FONT.mono, size: 34, color: C.accent, x: PAD, y: 690 }), f(160));
        rise(text(sc, "\u2192 .mcp/api/blog-api.yaml", { font: FONT.mono, size: 26, color: C.muted, x: PAD + 34, y: 732 }), f(160));
        sfx("tick", start, 160, -2);

        var kv = [["source", "postman"], ["endpointCount", "8"], ["base_url", "https://jsonplaceholder.typicode.com"], ["losses", "[]"]];
        for (var i = 0; i < kv.length; i++) {
            var yy = 800 + i * 46, at = f(178 + i * 14);
            rise(text(sc, kv[i][0] + ":", { font: FONT.mono, size: 30, color: C.muted, x: PAD + 34, y: yy }), at);
            rise(text(sc, kv[i][1], { font: FONT.mono, size: 30, color: kv[i][0] === "losses" ? C.pass : C.ink, x: PAD + 34 + (kv[i][0].length + 2) * 18, y: yy }), at);
        }

        rise(text(sc, "\u25B8 execute_api_flow", { font: FONT.mono, size: 34, color: C.accent, x: PAD, y: 1040 }), f(345));
        rise(text(sc, "8 steps \u00B7 1 chamada", { font: FONT.mono, size: 26, color: C.muted, x: PAD + 34, y: 1082 }), f(345));
        sfx("tick", start, 345, -2);
    }

    function buildRun(sc, start) {
        var ROW_START = 128, ROW_GAP = 17, STAMP = 16, i;
        sceneChrome(sc, SCENES[3].label, 250);

        var stamps = [];
        for (i = 0; i < RUN.length; i++) { stamps.push(f(ROW_START + i * ROW_GAP + STAMP)); }
        var lastStamp = stamps[stamps.length - 1];
        var done = EXPR.stepsDone(stamps);

        // Contador de passos: o numero fica verde quando os 8 passam (efeito Fill com expressao).
        var count = text(sc, "0", { font: FONT.sansBold, size: 60, x: PAD, y: 340, name: "passos ok (contador)" });
        sourceText(count).expression = done + "String(n);";
        var fill = count.property("ADBE Effect Parade").addProperty("ADBE Fill");
        var ink = rgb(C.ink), pass = rgb(C.pass);
        fill.property("ADBE Fill-0002").expression = done +
            "n >= stamps.length ? [" + pass.join(", ") + ", 1] : [" + ink.join(", ") + ", 1];";
        text(sc, "/ 8 ok", { font: FONT.sansBold, size: 60, color: C.muted, x: PAD + 52, y: 340 });

        // Ponto "rodando": pulsa em pingpong enquanto ha passos pendentes.
        var dot = rect(sc, PAD + 270, 312, 14, 14, C.accent, "rodando (pingpong)");
        var dop = op(dot);
        dop.setValueAtTime(0, 100);
        dop.setValueAtTime(0.4, 25);
        dop.expression = "time > " + lastStamp + " ? 0 : loopOut(\"pingpong\");";

        var elapsed = text(sc, "0 ms", { font: FONT.mono, size: 32, color: C.muted, right: true, x: W - PAD, y: 340, name: "ms total (contador)" });
        sourceText(elapsed).expression = EXPR.counter(f(ROW_START), lastStamp, 0, TOTAL_MS, " ms");

        rect(sc, PAD, 368, CONTENT, 2, C.rule, "rule");

        for (i = 0; i < RUN.length; i++) {
            var r = RUN[i], y = 430 + i * 66, at = f(ROW_START + i * ROW_GAP), st = at + f(STAMP);
            rise(text(sc, r.method, { font: FONT.monoSemi, size: 28, color: methodColor(r.method), x: PAD, y: y }), at, 16);
            rise(text(sc, r.path, { font: FONT.mono, size: 31, x: PAD + 132, y: y }), at, 16);
            fadeIn(text(sc, String(r.status), { font: FONT.mono, size: 30, color: C.pass, x: 720, y: y }), st, 0.2);
            var ms = text(sc, "0 ms", { font: FONT.mono, size: 28, color: C.muted, right: true, x: 930, y: y, name: r.path + " ms" });
            sourceText(ms).expression = EXPR.counter(at + f(2), st, 0, r.ms, " ms");
            fadeIn(ms, at, 0.3);

            var icon = checkIcon(sc, 985, y - 10, 42, "check " + (i + 1));
            icon.end.setValueAtTime(st, 0);
            icon.end.setValueAtTime(st + 0.35, 100);
            easeAll(icon.end, 70);
            pop(icon.layer, st, icon.size);

            fadeIn(rect(sc, PAD, y + 20, CONTENT, 3, C.rule, "trilho " + (i + 1)), at, 0.3);
            var bar = rect(sc, PAD, y + 20, CONTENT * r.ms / MAX_MS, 3, C.accent, "duracao " + (i + 1));
            op(bar).setValue(70);
            var bs = scl(bar);
            bs.setValueAtTime(at + f(2), [0, 100]);
            bs.setValueAtTime(st, [100, 100]);
            easeAll(bs, 60);

            sfx("tick", start, ROW_START + i * ROW_GAP + STAMP, -5);
        }

        rise(text(sc, "Cada passo com assert: status, campos\re tamanho da lista.", { size: 36, leading: 50, color: C.muted, x: PAD, y: 1000 }), lastStamp + f(24));
    }

    function buildResult(sc, start) {
        sceneChrome(sc, SCENES[4].label, 300);

        // Null que treme por um instante quando o chime toca (wiggle com janela).
        var shake = sc.layers.addNull();
        shake.name = "SHAKE (wiggle)";
        tr(shake).property("ADBE Anchor Point").setValue([0, 0]);
        pos(shake).setValue([0, 0]);
        pos(shake).expression = EXPR.gatedWiggle(f(55), 0.8);
        op(shake).setValue(0);

        var icon = checkIcon(sc, PAD + 75, 470, 150, "check grande");
        icon.end.setValueAtTime(f(20), 0);
        icon.end.setValueAtTime(f(34), 100);
        easeAll(icon.end, 70);
        pop(icon.layer, f(20), icon.size);
        icon.layer.parent = shake;

        var big = text(sc, "0", { font: FONT.sansBold, size: 210, color: C.pass, tracking: -30, x: 250, y: 545, name: "8 (contador)" });
        sourceText(big).expression = EXPR.counter(f(20), f(55), 0, 8, "");
        big.parent = shake;
        text(sc, "/8", { font: FONT.sansBold, size: 210, color: C.muted, tracking: -30, x: 372, y: 545 }).parent = shake;
        sfx("chime", start, 55, -6);

        rise(text(sc, "requests passaram.", { font: FONT.sansSemi, size: 52, x: PAD, y: 640 }), f(50));

        var stats = [
            ["1.543 ms", "para a collection inteira"],
            ["1", "chamada de ferramenta"],
            ["0", "perdas na convers\u00E3o"]
        ];
        for (var i = 0; i < stats.length; i++) {
            var at = f(75 + i * 18), y = 700 + i * 104;
            rise(rect(sc, PAD, y, CONTENT, 2, C.rule, "rule"), at);
            rise(text(sc, stats[i][0], { font: FONT.monoSemi, size: 46, color: C.accent, x: PAD, y: y + 70 }), at);
            rise(text(sc, stats[i][1], { size: 38, color: C.muted, x: PAD + 280, y: y + 68 }), at);
        }
    }

    function buildOutro(sc, start) {
        sceneChrome(sc, SCENES[5].label, 400);
        rise(text(sc, "Testar API", { font: FONT.sansBold, size: 88, x: PAD, y: 520 }), f(6));
        rise(text(sc, "conversando.", { font: FONT.sansBold, size: 88, color: C.accent, x: PAD, y: 620 }), f(6));
        rise(rect(sc, PAD, 690, CONTENT, 2, C.rule, "rule"), f(40));
        rise(text(sc, "Postman \u00B7 Insomnia \u00B7 OpenAPI \u00B7 curl", { size: 40, color: C.muted, x: PAD, y: 770 }), f(40));
        rise(text(sc, "github.com/Mr-Lucasz/", { font: FONT.mono, size: 34, x: PAD, y: 870 }), f(80));
        rise(text(sc, "conversational-api-test-mcp", { font: FONT.mono, size: 34, color: C.accent, x: PAD, y: 918 }), f(80));

        // Cursor piscando: keyframes HOLD repetidos com loopOut("cycle").
        var cursor = text(sc, "_", { font: FONT.mono, size: 34, color: C.accent, x: PAD + 27 * 20.4, y: 918, name: "cursor (loopOut)" });
        var co = op(cursor);
        co.setValueAtTime(f(80), 100);
        co.setValueAtTime(f(80) + 0.5, 0);
        co.setValueAtTime(f(80) + 1, 100);
        for (var k = 1; k <= co.numKeys; k++) {
            co.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
        }
        co.expression = "time < key(1).time ? 0 : loopOut(\"cycle\");";
    }

    // ---------- montagem ----------

    function addRig(main) {
        var rig = main.layers.addNull();
        rig.name = RIG;
        op(rig).setValue(0);
        var sliders = [["Wiggle Freq", 4], ["Wiggle Amp", 10], ["Bounce Amp", 0.05], ["Bounce Freq", 2.5], ["Bounce Decay", 7]];
        for (var i = 0; i < sliders.length; i++) {
            var fx = rig.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
            fx.name = sliders[i][0];
            fx.property("ADBE Slider Control-0001").setValue(sliders[i][1]);
        }
    }

    function addFrame(main) {
        text(main, "conversational-api-test-mcp", { font: FONT.mono, size: 26, color: C.muted, x: PAD, y: PAD + 26, name: "header" });
        var step = text(main, "01 / 06", { font: FONT.mono, size: 26, color: C.muted, right: true, x: W - PAD, y: PAD + 26, name: "cena (marcadores)" });
        sourceText(step).expression = EXPR.step;
        rect(main, PAD, PAD + 48, CONTENT, 2, C.rule, "header rule");
        rect(main, PAD, H - PAD - 4, CONTENT, 4, C.rule, "progresso trilho");
        scl(rect(main, PAD, H - PAD - 4, CONTENT, 4, C.accent, "progresso")).expression = EXPR.progress;
    }

    function addAudio(main, folder, duration) {
        var dir = new Folder(File($.fileName).parent.parent.fsName + "/public/audio");
        if (!dir.exists) { return "Pasta de audio nao encontrada: " + dir.fsName; }
        var cache = {};
        function item(name) {
            if (!cache[name]) {
                var file = new File(dir.fsName + "/" + name);
                if (!file.exists) { return null; }
                cache[name] = app.project.importFile(new ImportOptions(file));
                cache[name].parentFolder = folder;
            }
            return cache[name];
        }
        var audio = app.project.items.addComp("Audio", W, H, 1, duration, FPS);
        audio.parentFolder = folder;
        var music = item("music.wav");
        if (music) {
            var ml = audio.layers.add(music);
            ml.property("ADBE Audio Group").property("ADBE Audio Levels").setValue([-20, -20]);
            ml.outPoint = Math.min(duration, ml.outPoint);
        }
        for (var i = 0; i < SFX.length; i++) {
            var src = item(SFX[i].file);
            if (!src) { continue; }
            var l = audio.layers.add(src);
            l.startTime = SFX[i].t;
            l.property("ADBE Audio Group").property("ADBE Audio Levels").setValue([SFX[i].db, SFX[i].db]);
        }
        main.layers.add(audio).enabled = false; // camada so de audio
        return null;
    }

    app.beginUndoGroup("PostmanRun (MCP)");
    try {
        var proj = app.project || app.newProject();
        try { proj.expressionEngine = "javascript-1.0"; } catch (ignore) { }

        var total = 0, i;
        for (i = 0; i < SCENES.length; i++) { total += SCENES[i].frames; }
        var duration = f(total);

        var folder = proj.items.addFolder("PostmanRun \u00B7 MCP");
        var scenesFolder = proj.items.addFolder("cenas");
        scenesFolder.parentFolder = folder;

        var main = proj.items.addComp(MAIN, W, H, 1, duration, FPS);
        main.parentFolder = folder;
        main.bgColor = rgb(C.bg);
        main.layers.addSolid(rgb(C.bg), "BG", W, H, 1, duration);

        var startFrame = 0;
        for (i = 0; i < SCENES.length; i++) {
            var s = SCENES[i], start = f(startFrame), len = f(s.frames);
            var sc = proj.items.addComp("0" + (i + 1) + " " + s.id, W, H, 1, len, FPS);
            sc.parentFolder = scenesFolder;
            s.build(sc, start);

            var layer = main.layers.add(sc);
            layer.startTime = start;
            var o = op(layer);
            o.setValueAtTime(start, 0);
            o.setValueAtTime(start + f(10), 100);
            if (!s.hold) {
                o.setValueAtTime(start + len - f(10), 100);
                o.setValueAtTime(start + len, 0);
            }
            main.markerProperty.setValueAtTime(start, new MarkerValue(s.label));
            sfx("whoosh", start, 0, -12);
            vo(s.id, start);
            startFrame += s.frames;
        }

        addFrame(main);
        addRig(main);
        var audioWarning = addAudio(main, folder, duration);
        main.openInViewer();

        var missing = [];
        for (var name in fontWarnings) { if (fontWarnings.hasOwnProperty(name)) { missing.push(name); } }
        alert("PostmanRun pronto: " + SCENES.length + " cenas, " + Math.round(duration) + " s." +
            (missing.length ? "\n\nFontes substituidas (instale IBM Plex): " + missing.join(", ") : "") +
            (audioWarning ? "\n\n" + audioWarning : ""));
    } catch (err) {
        alert("Erro na linha " + err.line + ": " + err.toString());
    } finally {
        app.endUndoGroup();
    }
})();