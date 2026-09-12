import { createClipId, type Clip } from './clips';
import { validateBoundaries, validateLabel } from './time';

export interface ImportSuccess {
  ok: true;
  /** 还原后的片段（已生成页面内 id，按创建序号升序，即当初加入清单的顺序）。 */
  clips: Clip[];
  /** 后续新片段的创建序号：已有最大值 + 1；空清单为 0。 */
  nextCreatedAt: number;
}

export interface ImportFailure {
  ok: false;
  error: string;
}

export type ImportResult = ImportSuccess | ImportFailure;

/**
 * 校验并还原本工具此前导出的片段 JSON。
 *
 * 复用与打点/导出完全相同的规则：标签非空、0 ≤ 起点 < 终点 ≤ 取整后时长
 * （整数毫秒）、创建序号为非负整数且不重复。同时核对音频文件名与取整后
 * 时长，确保导入对象就是当前载入的这段录音。
 *
 * 全部记录通过才返回 clips；任一失败只返回错误原因，绝不产生部分结果，
 * 调用方据此保证“不改动导入前的清单、选择与播放位置”。
 */
export function parseImportPayload(
  text: string,
  audioFileName: string,
  durationMs: number,
): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '导入文件无法解析：不是有效的 JSON 文本。' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '导入文件无法解析：不是本工具导出的片段 JSON 对象。' };
  }
  const payload = raw as Record<string, unknown>;

  if (typeof payload.audioFileName !== 'string' || payload.audioFileName.length === 0) {
    return { ok: false, error: '导入文件缺少有效的 audioFileName 字段，不是本工具的导出格式。' };
  }
  if (payload.audioFileName !== audioFileName) {
    return {
      ok: false,
      error: `音频不匹配：导入文件对应「${payload.audioFileName}」，当前载入的是「${audioFileName}」。`,
    };
  }
  if (typeof payload.durationMs !== 'number' || !Number.isInteger(payload.durationMs)) {
    return { ok: false, error: '导入文件缺少有效的 durationMs 字段，不是本工具的导出格式。' };
  }
  if (payload.durationMs !== durationMs) {
    return {
      ok: false,
      error: `音频不匹配：导入文件记录的时长 ${payload.durationMs} ms 与当前音频 ${durationMs} ms 不一致。`,
    };
  }
  if (!Array.isArray(payload.clips)) {
    return { ok: false, error: '导入文件缺少 clips 数组，不是本工具的导出格式。' };
  }

  const restored: Clip[] = [];
  const seenCreatedAt = new Set<number>();
  for (const [i, record] of (payload.clips as unknown[]).entries()) {
    const nth = `第 ${i + 1} 条记录`;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return { ok: false, error: `${nth}不是有效的片段对象。` };
    }
    const r = record as Record<string, unknown>;

    if (typeof r.label !== 'string') {
      return { ok: false, error: `${nth}的标签缺失或不是文本。` };
    }
    const labelResult = validateLabel(r.label);
    if (!labelResult.ok) {
      return { ok: false, error: `${nth}：${labelResult.error}` };
    }
    if (typeof r.startMs !== 'number' || typeof r.endMs !== 'number') {
      return { ok: false, error: `${nth}的起点与终点必须是数值毫秒。` };
    }
    // 与加入片段时完全相同的毫秒边界规则（含整数、相等、反向、越界检查）。
    const boundary = validateBoundaries(r.startMs, r.endMs, durationMs);
    if (!boundary.ok) {
      return { ok: false, error: `${nth}：${boundary.error}` };
    }
    if (typeof r.createdAt !== 'number' || !Number.isInteger(r.createdAt) || r.createdAt < 0) {
      return { ok: false, error: `${nth}的创建序号必须是非负整数。` };
    }
    if (seenCreatedAt.has(r.createdAt)) {
      return { ok: false, error: `创建序号重复：${nth}的 createdAt = ${r.createdAt} 已出现过。` };
    }
    seenCreatedAt.add(r.createdAt);

    restored.push({
      id: createClipId(),
      startMs: r.startMs,
      endMs: r.endMs,
      label: r.label.trim(),
      createdAt: r.createdAt,
    });
  }

  // 导出文件按起点/终点排序；创建序号才代表当初加入清单的顺序，按它还原清单。
  restored.sort((a, b) => a.createdAt - b.createdAt);
  const nextCreatedAt =
    restored.length === 0 ? 0 : Math.max(...restored.map((c) => c.createdAt)) + 1;
  return { ok: true, clips: restored, nextCreatedAt };
}
