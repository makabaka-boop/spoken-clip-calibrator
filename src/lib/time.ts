/**
 * 时间码换算：全部以媒体时间（秒）乘以 1000 后四舍五入得到整数毫秒。
 * 对非负数 Math.round 即“四舍五入”（half up），不做任何整秒吸附。
 */
export function toMillis(mediaSeconds: number): number {
  return Math.round(mediaSeconds * 1000);
}

/** 毫秒整数格式化为 HH:MM:SS.mmm，仅用于展示，不参与任何计算。 */
export function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--:--.---';
  const total = Math.max(0, Math.trunc(ms));
  const millis = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${String(millis).padStart(3, '0')}`;
}

export interface BoundaryResult {
  ok: boolean;
  error?: string;
}

/**
 * 边界合法性：0 ≤ 起点 < 终点 ≤ 音频时长（三者同为四舍五入后的整数毫秒）。
 * 相等边界与反向边界都必须拒绝，且由调用方保证拒绝时不改动清单。
 */
export function validateBoundaries(
  startMs: number,
  endMs: number,
  durationMs: number,
): BoundaryResult {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || !Number.isInteger(durationMs)) {
    return { ok: false, error: '时间码必须是整数毫秒。' };
  }
  if (startMs < 0) {
    return { ok: false, error: '起点不能小于 0 毫秒。' };
  }
  if (startMs >= endMs) {
    return {
      ok: false,
      error:
        startMs === endMs
          ? `起点与终点相等（${startMs} ms），不构成片段。`
          : `反向边界：起点 ${startMs} ms 晚于终点 ${endMs} ms。`,
    };
  }
  if (endMs > durationMs) {
    return { ok: false, error: `终点 ${endMs} ms 超出音频时长 ${durationMs} ms。` };
  }
  return { ok: true };
}

/** 标签非空校验：去除两端空白后不允许为空。 */
export function validateLabel(label: string): BoundaryResult {
  if (label.trim().length === 0) {
    return { ok: false, error: '标签不能为空，请先填写可引用片段的说明。' };
  }
  return { ok: true };
}
