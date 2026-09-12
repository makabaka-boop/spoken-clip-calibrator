import { describe, expect, it } from 'vitest';
import {
  buildExportPayload,
  durationToMillis,
  reviseClipInList,
  reviseClipValues,
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

describe('reviseClipValues 校准校验（复用 Clip/标签/边界规则）', () => {
  const duration = 3250;

  it('合法修订通过，标签按既有规则去除首尾空白', () => {
    const result = reviseClipValues({ startMs: 100, endMs: 800, label: '  新标签  ' }, duration);
    expect(result).toEqual({ ok: true, startMs: 100, endMs: 800, label: '新标签' });
  });

  it('空标签被拒绝', () => {
    const result = reviseClipValues({ startMs: 100, endMs: 800, label: '   ' }, duration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('标签不能为空');
  });

  it('相等边界被拒绝', () => {
    const result = reviseClipValues({ startMs: 900, endMs: 900, label: '标签' }, duration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('相等');
  });

  it('反向边界被拒绝', () => {
    const result = reviseClipValues({ startMs: 1200, endMs: 800, label: '标签' }, duration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('反向');
  });

  it('终点超出音频时长被拒绝', () => {
    const result = reviseClipValues({ startMs: 100, endMs: 3251, label: '标签' }, duration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('超出音频时长');
  });
});

describe('reviseClipInList 校准保存：只更新三字段，不重建记录身份', () => {
  const duration = toMillis(3.25);

  it('更新后仍是同一条记录：id 与创建序号保持，数组顺序与长度不变', () => {
    const clips = [
      clip(1000, 1200, 0, '甲'),
      clip(100, 500, 1, '乙'),
      clip(2000, 2500, 2, '丙'),
    ];
    const target = clips[1];
    const revised = reviseClipInList(clips, target.id, {
      startMs: 200,
      endMs: 600,
      label: '乙（校准）',
    });

    expect(revised).toHaveLength(3);
    expect(revised.map((c) => c.id)).toEqual(clips.map((c) => c.id));
    expect(revised.map((c) => c.createdAt)).toEqual([0, 1, 2]);

    const updated = revised[1];
    // 页面标识与创建序号原样保留——记录身份未重建
    expect(updated.id).toBe(target.id);
    expect(updated.createdAt).toBe(target.createdAt);
    expect(updated).toMatchObject({ startMs: 200, endMs: 600, label: '乙（校准）' });
    // 未编辑的记录保持同一对象引用
    expect(revised[0]).toBe(clips[0]);
    expect(revised[2]).toBe(clips[2]);
    // 原数组不被修改
    expect(clips[1]).toBe(target);
    expect(clips[1]).toMatchObject({ startMs: 100, endMs: 500, label: '乙' });
  });

  it('找不到目标 id 时不改写任何记录（全部保持原引用）', () => {
    const clips = [clip(100, 500, 0, '甲')];
    const revised = reviseClipInList(clips, '不存在的 id', {
      startMs: 200,
      endMs: 600,
      label: '乙',
    });
    expect(revised[0]).toBe(clips[0]);
    expect(revised[0]).toMatchObject({ startMs: 100, endMs: 500, label: '甲' });
  });

  it('校准结果沿用导出/导入载荷形状：排序、复算与再导入无需格式升级', () => {
    const clips = [
      clip(1000, 1200, 0, '甲'),
      clip(100, 500, 1, '乙'),
    ];
    // 将乙的范围改为 50–300，createdAt 仍是 1
    const revised = reviseClipInList(clips, clips[1].id, {
      startMs: 50,
      endMs: 300,
      label: '乙',
    });
    const payload = buildExportPayload(revised, 'sample.wav', duration);
    expect(payload.clips.map((c) => c.createdAt)).toEqual([1, 0]);
    const edited = payload.clips[0];
    expect(edited).toMatchObject({ startMs: 50, endMs: 300, durationMs: 250, createdAt: 1 });
  });
});
