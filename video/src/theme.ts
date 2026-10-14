import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans";

const sans = loadSans("normal", { weights: ["400", "600", "700"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "600"], subsets: ["latin"] });

export const fonts = {
  sans: sans.fontFamily,
  mono: mono.fontFamily,
};

// Relatório de teste em terminal: fundo chapado, âmbar como único destaque,
// verde e vermelho reservados para veredictos.
export const colors = {
  bg: "#0F100D",
  ink: "#EDEBE4",
  muted: "#9A978C",
  rule: "#2E2F29",
  accent: "#F2B33D",
  pass: "#5FCB86",
  fail: "#F0625A",
  skip: "#8E8C83",
};

// Formato de feed do LinkedIn (4:5).
export const video = {
  width: 1080,
  height: 1350,
  fps: 30,
};

// Duração de cada cena, em frames. Acompanha a narração de public/audio/vo-*.mp3.
export const scenes = {
  hook: 235,
  cases: 490,
  chat: 195,
  checklist: 400,
  finding: 215,
  promises: 345,
  outro: 230,
};

// Frame, dentro da cena, em que a narração começa.
export const VO_START = 8;

export const totalFrames = Object.values(scenes).reduce((sum, n) => sum + n, 0);