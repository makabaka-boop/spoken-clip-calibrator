// 生成仓库内验收用短音频：3.25 秒、8 kHz、单声道、PCM16 WAV。
// 前半段 440 Hz、后半段 880 Hz，且幅度渐强，方便试听时“听得出来”。
// 用法：node scripts/make-test-audio.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outPath = join(root, 'test-assets', 'sample.wav');

const sampleRate = 8000;
const seconds = 3.25;
const numSamples = Math.round(sampleRate * seconds);
const bytesPerSample = 2;
const dataSize = numSamples * bytesPerSample;

const buffer = Buffer.alloc(44 + dataSize);
buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16); // fmt chunk size
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(1, 22); // 单声道
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
buffer.writeUInt16LE(bytesPerSample, 32); // block align
buffer.writeUInt16LE(16, 34); // bits per sample
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

const twoPi = Math.PI * 2;
for (let i = 0; i < numSamples; i += 1) {
  const t = i / sampleRate;
  const freq = t < seconds / 2 ? 440 : 880;
  // 轻微渐强，避免在两端产生突兀感
  const envelope = 0.35 + 0.4 * (i / numSamples);
  const value = Math.sin(twoPi * freq * t) * envelope;
  const intSample = Math.max(-1, Math.min(1, value)) * 0x7fff;
  buffer.writeInt16LE(Math.round(intSample), 44 + i * 2);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, buffer);
console.log(`Wrote ${outPath} (${seconds}s, ${sampleRate} Hz, ${dataSize} bytes PCM)`);
