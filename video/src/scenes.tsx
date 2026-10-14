import type { FC } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { clamp, Mono, Rise, Rule, Scene, Sfx, StatusIcon, statusColor, type Status } from "./components";
import { colors, fonts, scenes } from "./theme";

/** Sublinhado âmbar que se desenha da esquerda para a direita. */
const Underline: FC<{ at: number; children: string }> = ({ at, children }) => {
  const frame = useCurrentFrame();
  const width = interpolate(frame, [at, at + 18], [0, 100], clamp);
  return (
    <span style={{ position: "relative", color: colors.accent, whiteSpace: "nowrap" }}>
      {children}
      <span style={{ position: "absolute", left: 0, bottom: -6, height: 6, width: `${width}%`, background: colors.accent }} />
    </span>
  );
};

export const Hook: FC = () => (
  <Scene duration={scenes.hook} label="Servidor MCP · testes de API" vo="hook">
    <Rise delay={6} style={{ fontSize: 88, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2 }}>
      Uma bancada de testes de API que o seu <Underline at={70}>agente de IA</Underline> sabe operar.
    </Rise>
    <Sfx name="tick" at={137} volume={0.9} />
    <Rise delay={137}>
      <Rule style={{ margin: "56px 0 40px" }} />
      <div style={{ fontSize: 46, lineHeight: 1.3, color: colors.muted }}>
        E um QA chamado <span style={{ color: colors.ink, fontWeight: 600 }}>Vander</span> para operá-la.
      </div>
    </Rise>
  </Scene>
);

// `ask` e `answer` são os frames em que a narração faz a pergunta e responde.
const CASES = [
  { label: "GET, POST, PUT, PATCH, DELETE?", ask: 139, answer: 215 },
  { label: "Automatizar o token?", ask: 243, answer: 282 },
  { label: "Massa de dados complexa?", ask: 302, answer: 345 },
  { label: "Asserções de teste?", ask: 367, answer: 438 },
  { label: "Flows inteiros?", ask: 403, answer: 444 },
];

const CaseRow: FC<{ index: number }> = ({ index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { label, ask, answer } = CASES[index];
  const enter = spring({ frame: frame - ask, fps, config: { damping: 200 } });
  const stamp = spring({ frame: frame - answer, fps, config: { damping: 11, mass: 0.6 } });
  return (
    <div style={{ opacity: enter, transform: `translateX(${(1 - enter) * -40}px)` }}>
      <Sfx name="tick" at={answer} volume={0.9} />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "26px 0" }}>
        <div style={{ fontSize: 44, fontWeight: 600 }}>{label}</div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 40,
            fontWeight: 600,
            color: colors.accent,
            opacity: Math.min(1, stamp * 2),
            transform: `scale(${0.6 + stamp * 0.4})`,
            transformOrigin: "right center",
          }}
        >
          faz.
        </div>
      </div>
      <Rule />
    </div>
  );
};

export const Cases: FC = () => (
  <Scene duration={scenes.cases} label="A proposta é simples" vo="cases">
    <Rise delay={50} style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.12, letterSpacing: -1.5, marginBottom: 44 }}>
      Testar API conversando com o seu copiloto.
    </Rise>
    <Rule />
    {CASES.map((item, index) => (
      <CaseRow key={item.label} index={index} />
    ))}
  </Scene>
);

const COMMAND = "/vander .mcp/api/httpbin.yaml whoami";
const TYPE_START = 12;
const REPLY_AT = 66;

export const Chat: FC = () => {
  const frame = useCurrentFrame();
  const typed = COMMAND.slice(0, Math.max(0, Math.floor((frame - TYPE_START) / 1.3)));
  const typing = typed.length < COMMAND.length;
  const cursorOn = typing || Math.floor(frame / 15) % 2 === 0;
  return (
    <Scene duration={scenes.chat} label="Como é uma sessão" vo="chat">
      <Sfx name="typing" at={TYPE_START} volume={0.6} />
      <Sfx name="typing" at={TYPE_START + 24} volume={0.6} />
      <Sfx name="tick" at={REPLY_AT} volume={0.9} />
      <Rise delay={6}>
        <div style={{ fontFamily: fonts.mono, fontSize: 30, color: colors.muted, marginBottom: 14 }}>você</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 42, lineHeight: 1.4, minHeight: 118 }}>
          <span style={{ color: colors.accent }}>{"> "}</span>
          {typed}
          <span style={{ color: colors.accent, opacity: cursorOn ? 1 : 0 }}>_</span>
        </div>
      </Rise>
      <Rise delay={REPLY_AT}>
        <Rule style={{ margin: "44px 0" }} />
        <div style={{ fontFamily: fonts.mono, fontSize: 30, color: colors.accent, marginBottom: 14 }}>vander</div>
        <div style={{ fontSize: 50, fontWeight: 600, lineHeight: 1.25 }}>
          Vander aqui. Revisando <Mono color={colors.accent}>GET /bearer</Mono> no httpbin.org.
        </div>
        <div style={{ fontSize: 36, lineHeight: 1.4, color: colors.muted, marginTop: 28 }}>
          13 verificações automáticas. Só métodos seguros foram enviados.
        </div>
      </Rise>
    </Scene>
  );
};

// `at` é o frame em que a narração cita o eixo.
const CHECKS: { letter: string; axis: string; status: Status; detail: string; at: number }[] = [
  { letter: "V", axis: "Verbs", status: "pass", detail: "OPTIONS → 200", at: 88 },
  { letter: "A", axis: "Authorization", status: "fail", detail: "token inválido → 200", at: 107 },
  { letter: "N", axis: "Negative", status: "skip", detail: "nada a negar", at: 137 },
  { letter: "D", axis: "Data", status: "pass", detail: "200 · application/json", at: 164 },
  { letter: "E", axis: "Errors", status: "pass", detail: "nenhum 5xx, nada vazou", at: 188 },
  { letter: "R", axis: "Responsiveness", status: "pass", detail: "196 ms de 1000 ms", at: 203 },
];

const VERDICT_DELAY = 10;

const CheckRow: FC<{ index: number }> = ({ index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { letter, axis, status, detail, at } = CHECKS[index];
  const enter = spring({ frame: frame - at, fps, config: { damping: 200 } });
  const sinceVerdict = frame - at - VERDICT_DELAY;
  const verdict = spring({ frame: sinceVerdict, fps, config: { damping: 11, mass: 0.6 } });
  const failed = status === "fail";
  // A linha que falhou treme por um instante quando o veredicto aparece.
  const shake = failed && sinceVerdict >= 0 && sinceVerdict < 18 ? Math.sin(sinceVerdict * 1.7) * 12 * (1 - sinceVerdict / 18) : 0;
  return (
    <div style={{ opacity: enter, transform: `translateX(${(1 - enter) * -40 + shake}px)` }}>
      <Sfx name={failed ? "error" : "tick"} at={at + VERDICT_DELAY} volume={failed ? 0.3 : 0.9} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 30,
          padding: "20px 0 20px 24px",
          borderLeft: `6px solid ${failed && sinceVerdict >= 0 ? colors.fail : "transparent"}`,
        }}
      >
        <div style={{ width: 62, fontFamily: fonts.mono, fontSize: 68, fontWeight: 600, color: colors.accent }}>{letter}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 28, color: colors.muted }}>{axis}</div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 34,
              marginTop: 4,
              color: failed && sinceVerdict >= 0 ? statusColor.fail : colors.ink,
            }}
          >
            {detail}
          </div>
        </div>
        <div style={{ opacity: Math.min(1, verdict * 2), transform: `scale(${0.5 + verdict * 0.5})`, display: "flex" }}>
          <StatusIcon status={status} />
        </div>
      </div>
      <Rule />
    </div>
  );
};

const Count: FC<{ value: number; label: string; color: string; at: number }> = ({ value, label, color, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - at, fps, config: { damping: 12, mass: 0.6 } });
  const shown = Math.round(interpolate(frame, [at, at + 12], [0, value], clamp));
  return (
    <div style={{ flex: 1, opacity: Math.min(1, pop * 2) }}>
      <Sfx name="tick" at={at} volume={0.9} />
      <div style={{ fontFamily: fonts.mono, fontSize: 84, fontWeight: 600, color, lineHeight: 1 }}>{shown}</div>
      <div style={{ fontSize: 30, color: colors.muted, marginTop: 10 }}>{label}</div>
    </div>
  );
};

export const Checklist: FC = () => (
  <Scene duration={scenes.checklist} label="A heurística VANDER" vo="checklist">
    <Rule />
    {CHECKS.map((check, index) => (
      <CheckRow key={check.letter} index={index} />
    ))}
    <div style={{ display: "flex", marginTop: 48, paddingLeft: 30 }}>
      <Count value={8} label="passaram" color={colors.pass} at={280} />
      <Count value={1} label="falhou" color={colors.fail} at={313} />
      <Count value={4} label="puladas" color={colors.skip} at={342} />
    </div>
  </Scene>
);

const STATUS_AT = 78;

export const Finding: FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hit = spring({ frame: frame - STATUS_AT, fps, config: { damping: 9, mass: 0.6 } });
  return (
    <Scene duration={scenes.finding} label="Um achado" vo="finding">
      <Sfx name="error" at={STATUS_AT} volume={0.3} />
      <Rise delay={6} style={{ borderLeft: `6px solid ${colors.fail}`, paddingLeft: 32 }}>
        <div style={{ fontFamily: fonts.mono, fontSize: 34, color: colors.muted }}>Authorization: Bearer</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 48, fontWeight: 600, marginTop: 8 }}>vander-invalid-token</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 40, marginTop: 28, opacity: Math.min(1, hit * 2) }}>
          →{" "}
          <span
            style={{
              display: "inline-block",
              color: colors.fail,
              fontWeight: 600,
              transform: `scale(${0.6 + hit * 0.4})`,
              transformOrigin: "left center",
            }}
          >
            200
          </span>
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 36, marginTop: 8, color: colors.muted, opacity: Math.min(1, hit * 2) }}>
          "authenticated": true
        </div>
      </Rise>
      <Rise delay={110} style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.12, marginTop: 64, letterSpacing: -1.5 }}>
        O endpoint aceita qualquer bearer token.
      </Rise>
      <Rise delay={160} style={{ fontSize: 40, lineHeight: 1.35, color: colors.muted, marginTop: 32 }}>
        Em uma API real, é a diferença entre autenticação e checagem de header.
      </Rise>
    </Scene>
  );
};

// `at` é o frame em que a narração cita a promessa.
const PROMISES = [
  { n: "01", at: 80, title: "O request enviado é exatamente o declarado", note: "O agente escolhe; o servidor executa a partir do YAML." },
  { n: "02", at: 171, title: "A resposta custa poucos tokens", note: "Você decide quanto da resposta volta para a conversa." },
  { n: "03", at: 242, title: "Suas credenciais nunca entram na conversa", note: "Ficam na sua máquina e voltam como [REDACTED]." },
];

export const Promises: FC = () => (
  <Scene duration={scenes.promises} label="Três promessas do servidor" vo="promises">
    <Rule />
    {PROMISES.map((promise) => (
      <Rise key={promise.n} delay={promise.at}>
        <Sfx name="tick" at={promise.at} volume={0.9} />
        <div style={{ display: "flex", gap: 36, padding: "40px 0" }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 44, fontWeight: 600, color: colors.accent, lineHeight: 1.25 }}>
            {promise.n}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 50, fontWeight: 700, lineHeight: 1.15, letterSpacing: -0.5 }}>{promise.title}</div>
            <div style={{ fontSize: 34, lineHeight: 1.35, color: colors.muted, marginTop: 16 }}>{promise.note}</div>
          </div>
        </div>
        <Rule />
      </Rise>
    ))}
  </Scene>
);

export const Outro: FC = () => (
  <Scene duration={scenes.outro} label="Open source · MIT" vo="outro" hold>
    <Sfx name="chime" at={10} volume={0.9} />
    <Rise delay={6} style={{ fontSize: 96, fontWeight: 700, lineHeight: 1.06, letterSpacing: -2.5 }}>
      Conversational
      <br />
      API Test <span style={{ color: colors.accent }}>MCP</span>
    </Rise>
    <Rise delay={50} style={{ fontSize: 38, lineHeight: 1.35, color: colors.muted, marginTop: 40 }}>
      Cursor · VS Code + Copilot · Claude Code
    </Rise>
    <Rise delay={90}>
      <Rule style={{ margin: "56px 0 40px" }} />
      <div style={{ fontFamily: fonts.mono, fontSize: 32, color: colors.muted }}>github.com/Mr-Lucasz/</div>
      <div style={{ fontFamily: fonts.mono, fontSize: 44, fontWeight: 600, color: colors.accent, marginTop: 6 }}>
        conversational-api-test-mcp
      </div>
    </Rise>
    <Rise delay={125} style={{ fontSize: 28, color: colors.muted, marginTop: 48 }}>
      Demonstração: execução real contra o httpbin.org.
    </Rise>
  </Scene>
);