// Gera a trilha de fundo do vídeo (public/audio/music.wav) por síntese, sem dependências.
// Uso: node tools/make-music.mjs [segundos]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const seconds = Number(process.argv[2] ?? 72);
const rate = 44100;
const total = Math.round(seconds * rate);
const beat = 60 / 96;
const chordLength = beat * 8;

// Am7 · Fmaj7 · Cmaj7 · G6
const chords = [
  { bass: 110.0, notes: [220.0, 261.63, 329.63, 392.0] },
  { bass: 87.31, notes: [174.61, 220.0, 261.63, 329.63] },
  { bass: 130.81, notes: [196.0, 246.94, 261.63, 329.63] },
  { bass: 98.0, notes: [196.0, 246.94, 293.66, 329.63] },
];

const left = new Float64Array(total);
const right = new Float64Array(total);
const TAU = Math.PI * 2;

for (let i = 0; i < total; i++) {
  const t = i / rate;
  const position = t / chordLength;
  const index = Math.floor(position) % chords.length;
  const inChord = (position % 1) * chordLength;
  const chord = chords[index];

  // Pad: entra e sai devagar em cada acorde.
  const padEnv = Math.min(1, inChord / 0.9) * Math.min(1, (chordLength - inChord) / 0.9);
  let padL = 0;
  let padR = 0;
  for (const f of chord.notes) {
    padL += Math.sin(TAU * f * 0.997 * t) + 0.22 * Math.sin(TAU * f * 2 * t);
    padR += Math.sin(TAU * f * 1.003 * t) + 0.22 * Math.sin(TAU * f * 2.004 * t);
  }

  // Arpejo em colcheias, uma oitava acima.
  const step = beat / 2;
  const stepIndex = Math.floor(t / step);
  const inStep = t - stepIndex * step;
  const arpNote = chord.notes[[0, 2, 1, 3, 2, 1, 3, 2][stepIndex % 8]] * 2;
  const arp = Math.sin(TAU * arpNote * inStep) * Math.exp(-inStep * 9) * Math.min(1, inStep / 0.004);
  const pan = stepIndex % 2 === 0 ? 0.35 : 0.65;

  // Baixo: pulsa a cada tempo.
  const inBeat = t % beat;
  const bass = Math.sin(TAU * chord.bass * t) * (0.45 + 0.55 * Math.exp(-inBeat * 4)) * Math.min(1, inChord / 0.05);

  left[i] = 0.035 * padEnv * padL + 0.1 * arp * (1 - pan) + 0.16 * bass;
  right[i] = 0.035 * padEnv * padR + 0.1 * arp * pan + 0.16 * bass;
}

const pcm = Buffer.alloc(total * 4);
for (let i = 0; i < total; i++) {
  const t = i / rate;
  const fade = Math.min(1, t / 1.0) * Math.min(1, (seconds - t) / 3.0);
  pcm.writeInt16LE(Math.round(Math.tanh(left[i] * 1.4) * fade * 32000), i * 4);
  pcm.writeInt16LE(Math.round(Math.tanh(right[i] * 1.4) * fade * 32000), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../public/audio/music.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`${out} (${seconds}s)`);