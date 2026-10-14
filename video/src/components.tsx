import type { CSSProperties, FC, ReactNode } from "react";
import { AbsoluteFill, Easing, Html5Audio, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, fonts, VO_START } from "./theme";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export type SfxName = "tick" | "typing" | "error" | "whoosh" | "chime";

/** Toca um efeito sonoro a partir de `at` (em frames, relativo à cena). */
export const Sfx: FC<{ name: SfxName; at: number; volume?: number }> = ({ name, at, volume = 0.5 }) => (
  <Sequence from={at} durationInFrames={60} layout="none">
    <Html5Audio src={staticFile(`audio/sfx-${name}.mp3`)} volume={volume} />
  </Sequence>
);

/** Moldura de cena: narração, transição de entrada e fade. `hold` mantém o último frame visível. */
export const Scene: FC<{ duration: number; label: string; vo?: string; children: ReactNode; hold?: boolean }> = ({
  duration,
  label,
  vo,
  children,
  hold = false,
}) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, 10], [0, 1], clamp);
  const fadeOut = hold ? 1 : interpolate(frame, [duration - 10, duration], [1, 0], clamp);
  const wipe = interpolate(frame, [0, 16], [0, 100], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  return (
    <AbsoluteFill>
      <Sfx name="whoosh" at={0} volume={0.22} />
      {vo && (
        <Sequence from={VO_START} layout="none">
          <Html5Audio src={staticFile(`audio/vo-${vo}.mp3`)} volume={1.5} />
        </Sequence>
      )}
      <AbsoluteFill
        style={{
          opacity: fadeIn * fadeOut,
          padding: "190px 72px 110px",
          justifyContent: "center",
          fontFamily: fonts.sans,
          color: colors.ink,
        }}
      >
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 30,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: colors.accent,
            marginBottom: 36,
          }}
        >
          {label}
        </div>
        {children}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${wipe}%`,
          width: 6,
          background: colors.accent,
          opacity: interpolate(frame, [0, 4, 12, 16], [0, 1, 1, 0], clamp),
        }}
      />
    </AbsoluteFill>
  );
};
/** Sobe e aparece a partir de `delay` (em frames, relativo à cena). */
export const Rise: FC<{ delay?: number; children: ReactNode; style?: CSSProperties }> = ({
  delay = 0,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * 28}px)`, ...style }}>{children}</div>;
};

export const Mono: FC<{ children: ReactNode; color?: string; style?: CSSProperties }> = ({
  children,
  color,
  style,
}) => <span style={{ fontFamily: fonts.mono, color, ...style }}>{children}</span>;

export const Rule: FC<{ style?: CSSProperties }> = ({ style }) => (
  <div style={{ height: 2, background: colors.rule, ...style }} />
);

export type Status = "pass" | "fail" | "skip";

export const statusColor: Record<Status, string> = {
  pass: colors.pass,
  fail: colors.fail,
  skip: colors.skip,
};

/** Ícone desenhado em SVG, para não depender da fonte de emoji da máquina. */
export const StatusIcon: FC<{ status: Status; size?: number }> = ({ status, size = 60 }) => {
  const color = statusColor[status];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="29" fill="none" stroke={color} strokeWidth="4" />
      {status === "pass" && (
        <path d="M19 33 L28 42 L46 23" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {status === "fail" && (
        <path d="M22 22 L42 42 M42 22 L22 42" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" />
      )}
      {status === "skip" && <path d="M21 32 L43 32" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" />}
    </svg>
  );
};

/** Cabeçalho e rodapé fixos, como a moldura de um relatório. */
export const Frame: FC<{ step: number; steps: number }> = ({ step, steps }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 100], clamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: fonts.mono, color: colors.muted, fontSize: 26 }}>
      <div style={{ position: "absolute", top: 72, left: 72, right: 72 }}>
        <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: 22 }}>
          <span>conversational-api-test-mcp</span>
          <span>
            {pad(step)} / {pad(steps)}
          </span>
        </div>
        <Rule />
      </div>
      <div style={{ position: "absolute", left: 72, right: 72, bottom: 72, height: 4, background: colors.rule }}>
        <div style={{ height: 4, width: `${progress}%`, background: colors.accent }} />
      </div>
    </AbsoluteFill>
  );
};