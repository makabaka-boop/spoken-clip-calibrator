import { describe, expect, it } from 'vitest';
import { formatTimecode, toMillis, validateBoundaries, validateLabel } from './time';

describe('toMillis 四舍五入', () => {
  it('媒体秒数乘 1000 后四舍五入为整数毫秒，不吸附整秒', () => {
    expect(toMillis(0)).toBe(0);
    expect(toMillis(0.0004)).toBe(0);
    // 恰好 0.0005 s → 0.5 ms，四舍五入为 1
    expect(toMillis(0.0005)).toBe(1);
    expect(toMillis(0.0015)).toBe(2);
    expect(toMillis(1.2344)).toBe(1234);
    expect(toMillis(1.2345)).toBe(1235);
    expect(toMillis(3.25)).toBe(3250);
    expect(toMillis(59.9994)).toBe(59999);
    expect(toMillis(59.9995)).toBe(60000);
  });

  it('典型拖条/取整边界', () => {
    // 显示精度常见的两位小数显示为 1.23 时，底层仍按真实值取整
    expect(toMillis(1.2349)).toBe(1235);
    expect(toMillis(1.234_499_999)).toBe(1234);
  });
});

describe('formatTimecode 仅用于展示', () => {
  it('格式为 HH:MM:SS.mmm', () => {
    expect(formatTimecode(0)).toBe('00:00:00.000');
    expect(formatTimecode(300)).toBe('00:00:00.300');
    expect(formatTimecode(3250)).toBe('00:00:03.250');
    expect(formatTimecode(60_000)).toBe('00:01:00.000');
    expect(formatTimecode(3_723_456)).toBe('01:02:03.456');
  });
});

describe('validateBoundaries 边界合法性', () => {
  const duration = 3250;

  it('接受 0 ≤ 起点 < 终点 ≤ 时长', () => {
    expect(validateBoundaries(0, 3250, duration)).toEqual({ ok: true });
    expect(validateBoundaries(300, 1800, duration)).toEqual({ ok: true });
  });

  it('拒绝相等边界', () => {
    const r = validateBoundaries(1500, 1500, duration);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('相等');
  });

  it('拒绝反向边界', () => {
    const r = validateBoundaries(2000, 1000, duration);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('反向');
  });

  it('拒绝负起点', () => {
    expect(validateBoundaries(-1, 100, duration).ok).toBe(false);
  });

  it('终点不得超过时长（同样的毫秒值）', () => {
    const r = validateBoundaries(3000, 3251, duration);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超出音频时长');
    // 恰等时长合法
    expect(validateBoundaries(3000, 3250, duration).ok).toBe(true);
  });
});

describe('validateLabel 非空', () => {
  it('空白标签被拒绝', () => {
    expect(validateLabel('').ok).toBe(false);
    expect(validateLabel('   ').ok).toBe(false);
    expect(validateLabel('\t\n').ok).toBe(false);
  });

  it('非空白标签通过，并按去除首尾空白理解', () => {
    expect(validateLabel('  受访者回忆  ').ok).toBe(true);
  });
});
