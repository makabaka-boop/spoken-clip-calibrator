import { describe, expect, it } from 'vitest';
import {
  buildExportPayload,
  durationToMillis,
  sortClipsForExport,
  type Clip,
} from './clips';
import { toMillis } from './time';

const clip = (startMs: number, endMs: number, createdAt: number, label = '标签'): Clip => ({
  id: `c${createdAt}`,
  startMs,
  endMs,
  createdAt,
  label,
});

describe('sortClipsForExport 排序', () => {
  it('按起点、终点、创建序号依次升序，且不改变原数组', () => {
    const clips = [
      clip(1000, 1200, 0, '甲'),
      clip(100, 500, 1, '乙'),
      clip(100, 500, 2, '丙'), // 与乙同起点同终点，按创建序号
      clip(100, 300, 3, '丁'), // 同起点不同终点
    ];
    const sorted = sortClipsForExport(clips);
    expect(sorted.map((c) => c.label)).toEqual(['丁', '乙', '丙', '甲']);
    // 原清单顺序不变
    expect(clips.map((c) => c.label)).toEqual(['甲', '乙', '丙', '丁']);
  });
});

describe('buildExportPayload 导出内容', () => {
  it('包含文件名、时长毫秒、标签与边界，序号连续，片段时长可复算', () => {
    const durationMs = toMillis(3.25);
    expect(durationToMillis(3.25)).toBe(3250);

    const payload = buildExportPayload(
      [clip(1000, 1200, 0, '甲'), clip(100, 500, 1, '乙')],
      'sample.wav',
      durationMs,
    );

    expect(payload.audioFileName).toBe('sample.wav');
    expect(payload.durationMs).toBe(3250);
    expect(payload.clips).toHaveLength(2);

    const [first, second] = payload.clips;
    expect(first).toMatchObject({
      index: 0,
      startMs: 100,
      endMs: 500,
      durationMs: 400,
      label: '乙',
      createdAt: 1,
    });
    expect(second).toMatchObject({
      index: 1,
      startMs: 1000,
      endMs: 1200,
      durationMs: 200,
      label: '甲',
      createdAt: 0,
    });

    // 验收者从下载内容复算每个片段
    for (const c of payload.clips) {
      expect(c.durationMs).toBe(c.endMs - c.startMs);
      expect(c.startMs).toBeGreaterThanOrEqual(0);
      expect(c.startMs).toBeLessThan(c.endMs);
      expect(c.endMs).toBeLessThanOrEqual(payload.durationMs);
      expect(c.label.trim().length).toBeGreaterThan(0);
    }
  });
});
