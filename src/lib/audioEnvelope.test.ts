import { describe, expect, it } from 'vitest';
import {
  analyzeAudioEnvelope,
  buildAudioEnvelope,
  collectBucketPeaks,
  normalizePeaks,
  ratioToPositionMs,
} from './audioEnvelope';

// 以合成采样构造声道：Float32Array，允许正负峰值，便于核对绝对值与跨声道最大值。
const channel = (samples: number[]): Float32Array => Float32Array.from(samples);

describe('collectBucketPeaks 按时长等分取跨声道绝对峰值', () => {
  it('单声道按桶归集正负采样的绝对值，结果与采样出现顺序无关', () => {
    // 8 个采样等分为 4 桶（每桶 2 个采样）：
    // 桶0: |-0.2|, 0.5 -> 0.5；桶1: 0.1, |-0.8| -> 0.8
    // 桶2: 0.3, 0.2  -> 0.3；桶3: 0.9, |-0.4| -> 0.9
    const peaks = collectBucketPeaks([channel([-0.2, 0.5, 0.1, -0.8, 0.3, 0.2, 0.9, -0.4])], 4);
    // Float32Array 读回存在二进制精度误差，逐桶按容差比较。
    expect(peaks).toHaveLength(4);
    expect(peaks.map((p) => Number(p.toFixed(3)))).toEqual([0.5, 0.8, 0.3, 0.9]);
  });

  it('多声道逐采样取各声道间的绝对最大值', () => {
    // 每个采样跨两个声道取较大绝对值：
    // i0 max(|-1|, 0.5)=1；i1 max(0.25, |-0.75|)=0.75
    // 两个采样同属桶 0（4 桶 / 8 采样的前两个采样）
    const left = channel([-1, 0.25, 0, 0, 0, 0, 0, 0]);
    const right = channel([0.5, -0.75, 0, 0, 0, 0, 0, 0]);
    const peaks = collectBucketPeaks([left, right], 4);
    expect(peaks[0]).toBeCloseTo(1, 6);
    expect(peaks[1]).toBe(0);
    // i1 的 0.75 仍在第一桶，不会因声道差异漏掉
    expect(peaks[0]).toBeGreaterThanOrEqual(0.75);
  });

  it('桶数不整除采样数时按 floor 比例归属且桶数精确', () => {
    // 10 个采样 / 3 桶，归属 floor(i*3/10)：桶0 为采样 0–2，桶1 为 3–6，桶2 为 7–9。
    const data = channel([0.1, 0.2, 0.9, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 0.2]);
    const peaks = collectBucketPeaks([data], 3);
    expect(peaks).toHaveLength(3);
    expect(peaks[0]).toBeCloseTo(0.9, 6);
    expect(peaks[1]).toBeCloseTo(0.6, 6);
    expect(peaks[2]).toBeCloseTo(1.0, 6);
  });

  it('桶数多于采样数时仍返回精确桶数，空桶峰值为 0', () => {
    const peaks = collectBucketPeaks([channel([0.5, 0.25])], 4);
    expect(peaks).toHaveLength(4);
    // floor 归属：i0 -> 桶0，i1 -> 桶2
    expect(peaks[0]).toBe(0.5);
    expect(peaks[1]).toBe(0);
    expect(peaks[2]).toBeCloseTo(0.25, 6);
    expect(peaks[3]).toBe(0);
  });

  it('空声道 / 零长度采样返回全 0 且不抛错', () => {
    expect(collectBucketPeaks([], 8)).toEqual(new Array(8).fill(0));
    expect(collectBucketPeaks([channel([])], 8)).toEqual(new Array(8).fill(0));
  });
});

describe('normalizePeaks 按整段最大峰值归一化', () => {
  it('全部峰值除以整段最大值，最大桶恰为 1，其余为线性比例', () => {
    const normalized = normalizePeaks([0.2, 0.5, 0.8, 0.4]);
    expect(normalized.map((v) => Number(v.toFixed(6)))).toEqual([0.25, 0.625, 1, 0.5]);
    expect(normalized[2]).toBe(1);
  });

  it('整段静音（全 0）返回全 0 且不产生 Infinity / NaN', () => {
    const normalized = normalizePeaks([0, 0, 0]);
    expect(normalized).toEqual([0, 0, 0]);
    expect(normalized.every(Number.isFinite)).toBe(true);
  });

  it('不修改入参，且所有结果落在 0–1', () => {
    const input = [0.3, 0.1, 0.6];
    const snapshot = [...input];
    const normalized = normalizePeaks(input);
    expect(input).toEqual(snapshot);
    expect(normalized.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

describe('buildAudioEnvelope 合成多声道整段概览', () => {
  it('durationMs 由采样数 / 采样率四舍五入，桶数与峰值轮廓自洽', () => {
    // 32500 个采样 @ 10 kHz = 3.25 s -> 3250 ms
    const mono = Float32Array.from({ length: 32500 }, (_, i) =>
      Math.sin((i / 32500) * Math.PI * 8),
    );
    const envelope = buildAudioEnvelope([mono], 10000, 10);
    expect(envelope.durationMs).toBe(3250);
    expect(envelope.bucketCount).toBe(10);
    expect(envelope.peaks).toHaveLength(10);
    expect(Math.max(...envelope.peaks)).toBeCloseTo(1, 6);
    expect(envelope.peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('合成立体声：各声道不同位置的峰值都能在归一化轮廓中呈现为 1', () => {
    // 20 个采样 @ 1000 Hz -> 20 ms，分 4 桶
    const left = Float32Array.from({ length: 20 }, (_, i) =>
      i === 2 ? -0.8 : 0.01,
    );
    const right = Float32Array.from({ length: 20 }, (_, i) =>
      i === 15 ? 0.4 : 0.01,
    );
    const envelope = buildAudioEnvelope([left, right], 1000, 4);
    expect(envelope.durationMs).toBe(20);
    // 左声道峰值在桶 0（i=2 -> floor(2*4/20)=0），右声道峰值在桶 3
    expect(envelope.peaks[0]).toBeCloseTo(1, 6);
    expect(envelope.peaks[3]).toBeCloseTo(0.5, 6); // 0.4 / 全局最大 0.8
  });

  it('合成静音整段轮廓全为 0', () => {
    const silence = new Float32Array(8000);
    const envelope = buildAudioEnvelope([silence], 8000, 16);
    expect(envelope.durationMs).toBe(1000);
    expect(envelope.peaks).toEqual(new Array(16).fill(0));
  });

  it('非法声道 / 采样率 / 桶数抛出编程错误', () => {
    expect(() => buildAudioEnvelope([], 8000, 8)).toThrow();
    expect(() => buildAudioEnvelope([new Float32Array(8)], 0, 8)).toThrow();
    expect(() => buildAudioEnvelope([new Float32Array(8)], 8000, 0)).toThrow();
    expect(() => buildAudioEnvelope([new Float32Array(8)], 8000, 2.5)).toThrow();
  });
});

describe('ratioToPositionMs 点击横向比例换算', () => {
  it('按横向比例换算为整数毫秒定位点', () => {
    expect(ratioToPositionMs(0, 3250)).toBe(0);
    expect(ratioToPositionMs(0.4, 3250)).toBe(1300);
    expect(ratioToPositionMs(1, 3250)).toBe(3250);
  });

  it('比例与结果都钳制到合法区间', () => {
    expect(ratioToPositionMs(-0.5, 3250)).toBe(0);
    expect(ratioToPositionMs(1.7, 3250)).toBe(3250);
    expect(ratioToPositionMs(Number.NaN, 3250)).toBe(0);
    expect(ratioToPositionMs(Number.POSITIVE_INFINITY, 3250)).toBe(3250);
  });

  it('换算采用四舍五入整数毫秒，与打点同一取整规则', () => {
    // 0.0004 的比例 * 3250 = 1.3 -> 1
    expect(ratioToPositionMs(0.0004, 3250)).toBe(1);
    // 1/3 * 3000 = 1000
    expect(ratioToPositionMs(1 / 3, 3000)).toBe(1000);
  });
});

describe('analyzeAudioEnvelope 浏览器解码服务', () => {
  it('桶数非法时同步以失败结果说明原因（不触碰文件解码）', async () => {
    const result = await analyzeAudioEnvelope(new File([new ArrayBuffer(0)], 'x.wav'), 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('桶数');
  });
});
