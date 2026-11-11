import type { FC } from "react";
import { AbsoluteFill } from "remotion";
import { Rule, StatusIcon } from "./components";
import { colors, fonts } from "./theme";

// Os 8 requests da collection Blog API, na ordem em que rodaram (todos passaram).
const METHODS = ["GET", "GET", "POST", "PUT", "PATCH", "DELETE", "GET", "GET"];

/** Capa do vídeo PostmanRun: o centro fica livre para o botão de play do LinkedIn. */
export const PostmanCover: FC = () => (
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
        Postman → MCP
      </div>
      <div style={{ fontSize: 104, fontWeight: 700, lineHeight: 1.06, letterSpacing: -3, marginTop: 28 }}>
        Sua collection do Postman, <span style={{ color: colors.accent }}>rodando inteira</span> no chat.
      </div>
    </div>

    <div>
      <div style={{ fontFamily: fonts.mono, fontSize: 38, marginBottom: 36 }}>
        <span style={{ color: colors.accent }}>{"> "}</span>
        importa a collection e roda tudo
      </div>
      <Rule />
      <div style={{ display: "flex", justifyContent: "space-between", padding: "32px 0" }}>
        {METHODS.map((method, index) => (
          <div key={index} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <StatusIcon status="pass" size={64} />
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 21,
                fontWeight: 600,
                color: method === "GET" ? colors.muted : colors.ink,
              }}
            >
              {method}
            </div>
          </div>
        ))}
      </div>
      <Rule />
      <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginTop: 30 }}>
        <span style={{ fontSize: 88, fontWeight: 700, letterSpacing: -2, color: colors.pass, lineHeight: 1 }}>8/8</span>
        <span style={{ fontSize: 38, lineHeight: 1.3, color: colors.muted }}>
          em <span style={{ color: colors.ink, fontWeight: 600 }}>1,5 s</span>, numa única chamada.
        </span>
      </div>
    </div>
  </AbsoluteFill>
);