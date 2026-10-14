import type { FC } from "react";
import { AbsoluteFill } from "remotion";
import { Rule, StatusIcon, type Status } from "./components";
import { colors, fonts } from "./theme";

const AXES: { letter: string; status: Status }[] = [
  { letter: "V", status: "pass" },
  { letter: "A", status: "fail" },
  { letter: "N", status: "skip" },
  { letter: "D", status: "pass" },
  { letter: "E", status: "pass" },
  { letter: "R", status: "pass" },
];

/** Capa do vídeo: o centro fica livre para o botão de play do LinkedIn. */
export const Cover: FC = () => (
  <AbsoluteFill
    style={{
      background: colors.bg,
      color: colors.ink,
      fontFamily: fonts.sans,
      padding: 72,
      justifyContent: "space-between",
    }}
  >
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: fonts.mono,
          fontSize: 26,
          color: colors.muted,
          paddingBottom: 22,
        }}
      >
        <span>conversational-api-test-mcp</span>
        <span>open source · MIT</span>
      </div>
      <Rule />
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 32,
          letterSpacing: 3,
          textTransform: "uppercase",
          color: colors.accent,
          marginTop: 64,
        }}
      >
        Servidor MCP · testes de API
      </div>
      <div style={{ fontSize: 112, fontWeight: 700, lineHeight: 1.06, letterSpacing: -3, marginTop: 28 }}>
        Teste de API <span style={{ color: colors.accent }}>conversando</span> com o seu copiloto.
      </div>
    </div>

    <div>
      <div style={{ fontFamily: fonts.mono, fontSize: 38, marginBottom: 36 }}>
        <span style={{ color: colors.accent }}>{"> "}</span>
        /vander httpbin.yaml whoami
      </div>
      <Rule />
      <div style={{ display: "flex", justifyContent: "space-between", padding: "36px 12px" }}>
        {AXES.map(({ letter, status }) => (
          <div key={letter} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 92, fontWeight: 600, color: colors.accent, lineHeight: 1 }}>
              {letter}
            </div>
            <StatusIcon status={status} size={72} />
          </div>
        ))}
      </div>
      <Rule />
      <div style={{ fontSize: 40, lineHeight: 1.3, color: colors.muted, marginTop: 36 }}>
        GET, POST, token, asserções, flows inteiros:{" "}
        <span style={{ color: colors.ink, fontWeight: 600 }}>é só pedir.</span>
      </div>
    </div>
  </AbsoluteFill>
);