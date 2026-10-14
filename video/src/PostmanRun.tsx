import type { FC } from "react";
import { AbsoluteFill, Html5Audio, interpolate, Series, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { clamp, Frame, Mono, Rise, Rule, Scene, Sfx, StatusIcon } from "./components";
import { colors, fonts } from "./theme";

// Duração de cada cena, em frames (30 fps). Acompanha a narração de public/audio/vo-pm-*.mp3.
export const postmanScenes = {
  intro: 249,
  collection: 379,
  prompt: 398,
  run: 453,
  result: 220,
  outro: 225,
};

export const postmanTotalFrames = Object.values(postmanScenes).reduce((sum, n) => sum + n, 0);

// Execução real de video/demo/blog-api.postman_collection.json contra o JSONPlaceholder,
// feita com convert_legacy_to_canonical + execute_api_flow (8/8 ok).
const RUN = [
  { folder: "Posts", name: "List posts", method: "GET", path: "/posts", status: 200, ms: 127 },
  { folder: "Posts", name: "Get post", method: "GET", path: "/posts/1", status: 200, ms: 43 },
  { folder: "Posts", name: "Create post", method: "POST", path: "/posts", status: 201, ms: 211 },
  { folder: "Posts", name: "Update post", method: "PUT", path: "/posts/1", status: 200, ms: 458 },
  { folder: "Posts", name: "Patch post title", method: "PATCH", path: "/posts/1", status: 200, ms: 157 },
  { folder: "Posts", name: "Delete post", method: "DELETE", path: "/posts/1", status: 200, ms: 191 },
  { folder: "Comments", name: "Comments of post", method: "GET", path: "/comments?postId=1", status: 200, ms: 292 },
  { folder: "Users", name: "Get user", method: "GET", path: "/users/1", status: 200, ms: 64 },
];

const TOTAL_MS = RUN.reduce((sum, r) => sum + r.ms, 0);
const MAX_MS = Math.max(...RUN.map((r) => r.ms));

/** Digita `text` a partir de `start`, um caractere a cada `speed` frames. */
const useTyped = (text: string, start: number, speed = 1.2) => {
  const frame = useCurrentFrame();
  const typed = text.slice(0, Math.max(0, Math.floor((frame - start) / speed)));
  const typing = typed.length < text.length;
  const cursorOn = typing || Math.floor(frame / 15) % 2 === 0;
  return { typed, cursorOn };
};

const Intro: FC = () => (
  <Scene duration={postmanScenes.intro} label="Postman → MCP" vo="pm-intro">
    <Rise delay={6} style={{ fontSize: 92, fontWeight: 700, lineHeight: 1.08, letterSpacing: -2 }}>
      Sua collection do Postman.
    </Rise>
    <Sfx name="tick" at={158} volume={0.9} />
    <Rise delay={158} style={{ fontSize: 92, fontWeight: 700, lineHeight: 1.08, letterSpacing: -2, color: colors.accent }}>
      Rodando inteira, dentro do agente.
    </Rise>
    <Rise delay={194}>
      <Rule style={{ margin: "56px 0 36px" }} />
      <div style={{ fontSize: 40, lineHeight: 1.35, color: colors.muted }}>
        Sem abrir o Postman. Sem Newman. Uma frase no chat.
      </div>
    </Rise>
  </Scene>
);

const MethodTag: FC<{ method: string; size?: number }> = ({ method, size = 30 }) => (
  <Mono
    color={method === "GET" ? colors.muted : colors.ink}
    style={{ display: "inline-block", width: size * 4.7, fontSize: size, fontWeight: 600 }}
  >
    {method}
  </Mono>
);

const Collection: FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let lastFolder = "";
  let row = 0;
  return (
    <Scene duration={postmanScenes.collection} label="A collection" vo="pm-collection">
      <Rise delay={4}>
        <Mono color={colors.muted} style={{ fontSize: 28 }}>
          video/demo/blog-api.postman_collection.json
        </Mono>
        <div style={{ fontSize: 64, fontWeight: 700, margin: "14px 0 30px", letterSpacing: -1 }}>Blog API</div>
        <Rule />
      </Rise>
      <div style={{ marginTop: 18 }}>
        {RUN.map((r, i) => {
          const showFolder = r.folder !== lastFolder;
          lastFolder = r.folder;
          const at = 18 + row * 12;
          row += showFolder ? 2 : 1;
          const p = spring({ frame: frame - at, fps, config: { damping: 200 } });
          return (
            <div key={r.name} style={{ opacity: p, transform: `translateX(${(1 - p) * -30}px)` }}>
              {showFolder && (
                <div style={{ fontFamily: fonts.mono, fontSize: 30, color: colors.accent, margin: "18px 0 6px" }}>
                  ▾ {r.folder}
                </div>
              )}
              <div style={{ fontSize: 38, padding: "7px 0 7px 36px", display: "flex", alignItems: "baseline" }}>
                <MethodTag method={r.method} />
                <span>{r.name}</span>
                {i === 0 && <Sfx name="tick" at={at} volume={0.5} />}
              </div>
            </div>
          );
        })}
      </div>
      <Rise delay={255}>
        <Rule style={{ margin: "26px 0 22px" }} />
        <Mono color={colors.muted} style={{ fontSize: 30 }}>
          8 requests · 3 pastas · host em <span style={{ color: colors.ink }}>{"{{baseUrl}}"}</span>
        </Mono>
      </Rise>
    </Scene>
  );
};

const PROMPT = "importa a collection do Blog API e roda tudo";
const CONVERT_RESULT = [
  ["source", "postman"],
  ["endpointCount", "8"],
  ["base_url", "https://jsonplaceholder.typicode.com"],
  ["losses", "[]"],
];

const ToolCall: FC<{ name: string; note: string }> = ({ name, note }) => (
  <div style={{ fontFamily: fonts.mono, fontSize: 34 }}>
    <span style={{ color: colors.accent }}>▸ {name}</span>
    <div style={{ color: colors.muted, fontSize: 26, margin: "8px 0 0 34px" }}>{note}</div>
  </div>
);

const Prompt: FC = () => {
  const { typed, cursorOn } = useTyped(PROMPT, 90, 1.5);
  return (
    <Scene duration={postmanScenes.prompt} label="Uma frase no chat" vo="pm-prompt">
      <Sfx name="typing" at={90} volume={0.45} />
      <Sfx name="typing" at={120} volume={0.45} />
      <Rise delay={4}>
        <div style={{ fontFamily: fonts.mono, fontSize: 28, color: colors.muted, marginBottom: 12 }}>você</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 44, lineHeight: 1.35, minHeight: 120 }}>
          <span style={{ color: colors.accent }}>{"> "}</span>
          {typed}
          <span style={{ color: colors.accent, opacity: cursorOn ? 1 : 0 }}>_</span>
        </div>
      </Rise>
      <Rise delay={160}>
        <Rule style={{ margin: "36px 0 30px" }} />
        <Sfx name="tick" at={160} volume={0.8} />
        <ToolCall name="convert_legacy_to_canonical" note="→ .mcp/api/blog-api.yaml" />
      </Rise>
      <div style={{ margin: "18px 0 0 34px" }}>
        {CONVERT_RESULT.map(([key, value], i) => (
          <Rise key={key} delay={178 + i * 14}>
            <div style={{ fontFamily: fonts.mono, fontSize: 30, lineHeight: 1.55 }}>
              <span style={{ color: colors.muted }}>{key}: </span>
              <span style={{ color: key === "losses" ? colors.pass : colors.ink }}>{value}</span>
            </div>
          </Rise>
        ))}
      </div>
      <Rise delay={345} style={{ marginTop: 34 }}>
        <Sfx name="tick" at={345} volume={0.8} />
        <ToolCall name="execute_api_flow" note="8 steps · 1 chamada" />
      </Rise>
    </Scene>
  );
};

const ROW_START = 128;
const ROW_GAP = 17;
const STAMP_DELAY = 16;

const RunRow: FC<{ index: number }> = ({ index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = RUN[index];
  const at = ROW_START + index * ROW_GAP;
  const enter = spring({ frame: frame - at, fps, config: { damping: 200 } });
  const stamp = spring({ frame: frame - at - STAMP_DELAY, fps, config: { damping: 10, mass: 0.6 } });
  const bar = interpolate(frame, [at + 2, at + STAMP_DELAY], [0, r.ms / MAX_MS], clamp);
  return (
    <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * 16}px)` }}>
      <Sfx name="tick" at={at + STAMP_DELAY} volume={0.7} />
      <div style={{ display: "flex", alignItems: "center", padding: "15px 0 8px", fontFamily: fonts.mono }}>
        <MethodTag method={r.method} size={28} />
        <span style={{ flex: 1, fontSize: 31, color: colors.ink }}>{r.path}</span>
        <span style={{ width: 90, fontSize: 30, color: colors.pass, opacity: Math.min(1, stamp * 2) }}>{r.status}</span>
        <span style={{ width: 120, fontSize: 28, color: colors.muted, textAlign: "right", marginRight: 22 }}>
          {Math.round(bar * MAX_MS)} ms
        </span>
        <div style={{ transform: `scale(${stamp})` }}>
          <StatusIcon status="pass" size={42} />
        </div>
      </div>
      <div style={{ height: 3, background: colors.rule }}>
        <div style={{ height: 3, width: `${bar * 100}%`, background: colors.accent, opacity: 0.7 }} />
      </div>
    </div>
  );
};

const Run: FC = () => {
  const frame = useCurrentFrame();
  const done = RUN.filter((_, i) => frame >= ROW_START + i * ROW_GAP + STAMP_DELAY).length;
  const lastStamp = ROW_START + (RUN.length - 1) * ROW_GAP + STAMP_DELAY;
  const elapsed = Math.round(interpolate(frame, [ROW_START, lastStamp], [0, TOTAL_MS], clamp));
  return (
    <Scene duration={postmanScenes.run} label="execute_api_flow" vo="pm-run">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20 }}>
        <div style={{ fontSize: 60, fontWeight: 700, letterSpacing: -1 }}>
          <span style={{ color: done === RUN.length ? colors.pass : colors.ink }}>{done}</span>
          <span style={{ color: colors.muted }}> / {RUN.length} ok</span>
        </div>
        <Mono color={colors.muted} style={{ fontSize: 32 }}>
          {elapsed.toLocaleString("pt-BR")} ms
        </Mono>
      </div>
      <Rule />
      {RUN.map((r, i) => (
        <RunRow key={r.name} index={i} />
      ))}
      <Rise delay={lastStamp + 24} style={{ marginTop: 36 }}>
        <div style={{ fontSize: 36, lineHeight: 1.4, color: colors.muted }}>
          Cada passo com <span style={{ color: colors.ink }}>assert</span>: status, campos e tamanho da lista.
        </div>
      </Rise>
    </Scene>
  );
};

const Count: FC<{ from: number; to: number; start: number; end: number }> = ({ from, to, start, end }) => {
  const frame = useCurrentFrame();
  return <>{Math.round(interpolate(frame, [start, end], [from, to], clamp))}</>;
};

const STATS = [
  { value: `${TOTAL_MS.toLocaleString("pt-BR")} ms`, label: "para a collection inteira" },
  { value: "1", label: "chamada de ferramenta" },
  { value: "0", label: "perdas na conversão" },
];

const Result: FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 20, fps, config: { damping: 9, mass: 0.7 } });
  return (
    <Scene duration={postmanScenes.result} label="Resultado" vo="pm-result">
      <Sfx name="chime" at={55} volume={0.5} />
      <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
        <div style={{ transform: `scale(${pop})` }}>
          <StatusIcon status="pass" size={150} />
        </div>
        <div style={{ fontSize: 210, fontWeight: 700, letterSpacing: -6, color: colors.pass, lineHeight: 1 }}>
          <Count from={0} to={8} start={20} end={55} />
          <span style={{ color: colors.muted }}>/8</span>
        </div>
      </div>
      <Rise delay={50} style={{ fontSize: 52, fontWeight: 600, margin: "24px 0 40px" }}>
        requests passaram.
      </Rise>
      {STATS.map((s, i) => (
        <Rise key={s.label} delay={75 + i * 18}>
          <Rule />
          <div style={{ display: "flex", alignItems: "baseline", gap: 28, padding: "24px 0" }}>
            <Mono color={colors.accent} style={{ fontSize: 46, fontWeight: 600, minWidth: 250 }}>
              {s.value}
            </Mono>
            <span style={{ fontSize: 38, color: colors.muted }}>{s.label}</span>
          </div>
        </Rise>
      ))}
    </Scene>
  );
};

const Outro: FC = () => (
  <Scene duration={postmanScenes.outro} label="Open source · MIT" vo="pm-outro" hold>
    <Rise delay={6} style={{ fontSize: 88, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2 }}>
      Testar API <span style={{ color: colors.accent }}>conversando.</span>
    </Rise>
    <Rise delay={40}>
      <Rule style={{ margin: "48px 0 36px" }} />
      <div style={{ fontSize: 40, color: colors.muted, lineHeight: 1.4 }}>Postman · Insomnia · OpenAPI · curl</div>
    </Rise>
    <Rise delay={80} style={{ marginTop: 44 }}>
      <Mono color={colors.ink} style={{ fontSize: 34 }}>
        github.com/Mr-Lucasz/
        <br />
        <span style={{ color: colors.accent }}>conversational-api-test-mcp</span>
      </Mono>
    </Rise>
  </Scene>
);

const order = [
  { duration: postmanScenes.intro, Component: Intro },
  { duration: postmanScenes.collection, Component: Collection },
  { duration: postmanScenes.prompt, Component: Prompt },
  { duration: postmanScenes.run, Component: Run },
  { duration: postmanScenes.result, Component: Result },
  { duration: postmanScenes.outro, Component: Outro },
];

export const PostmanRun: FC = () => {
  const frame = useCurrentFrame();
  let elapsed = 0;
  let step = order.length;
  for (let i = 0; i < order.length; i++) {
    elapsed += order[i].duration;
    if (frame < elapsed) {
      step = i + 1;
      break;
    }
  }
  return (
    <AbsoluteFill>
      <Html5Audio src={staticFile("audio/music.wav")} volume={0.1} />
      <Frame step={step} steps={order.length} />
      <Series>
        {order.map(({ duration, Component }, index) => (
          <Series.Sequence key={index} durationInFrames={duration}>
            <Component />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};