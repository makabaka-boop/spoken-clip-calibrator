import { toMillis, validateBoundaries, validateLabel } from './time';

/** 一条可引用片段。createdAt 为加入清单时的创建序号（从 0 起）。 */
export interface Clip {
  id: string;
  startMs: number;
  endMs: number;
  label: string;
  createdAt: number;
}

export interface ExportedClip {
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  label: string;
  createdAt: number;
}

export interface ExportPayload {
  audioFileName: string;
  durationMs: number;
  clips: ExportedClip[];
}

/**
 * 导出排序：起点升序 → 终点升序 → 创建序号升序。
 * 不改变界面清单的创建顺序，仅影响导出内容。
 */
export function sortClipsForExport(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    return a.createdAt - b.createdAt;
  });
}

export function buildExportPayload(
  clips: readonly Clip[],
  audioFileName: string,
  durationMs: number,
): ExportPayload {
  const sorted = sortClipsForExport(clips);
  return {
    audioFileName,
    durationMs,
    clips: sorted.map((clip, index) => ({
      index,
      startMs: clip.startMs,
      endMs: clip.endMs,
      durationMs: clip.endMs - clip.startMs,
      label: clip.label,
      createdAt: clip.createdAt,
    })),
  };
}

export function exportClipsAsJson(payload: ExportPayload): Blob {
  return new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json',
  });
}

/** 触发浏览器下载，全程不经过任何网络。 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 让下载有机会启动后再回收对象 URL。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 媒体时长用同一套取整规则，保证“终点 ≤ 时长”比较的是同样的毫秒值。 */
export function durationToMillis(mediaSeconds: number): number {
  return toMillis(mediaSeconds);
}

export interface ClipRevision {
  startMs: number;
  endMs: number;
  label: string;
}

export type ClipRevisionResult =
  | ({ ok: true } & ClipRevision)
  | { ok: false; error: string };

/**
 * 校准（修订）一条已存在片段：复用与加入片段、导入完全相同的
 * 标签非空与毫秒边界规则（0 ≤ 起点 < 终点 ≤ 时长）。
 *
 * 纯函数：不修改传入对象；只产出新的起点、终点、标签，由调用方在原记录
 * 上替换这三个字段，页面标识 id 与创建序号 createdAt 原样保留，因此导出
 * 排序、再次导入都无需格式升级。校验失败只返回原因，不产生部分结果。
 */
export function reviseClipValues(
  revision: ClipRevision,
  durationMs: number,
): ClipRevisionResult {
  const labelResult = validateLabel(revision.label);
  if (!labelResult.ok) {
    return { ok: false, error: labelResult.error ?? '标签不合法。' };
  }
  const boundary = validateBoundaries(revision.startMs, revision.endMs, durationMs);
  if (!boundary.ok) {
    return { ok: false, error: boundary.error ?? '边界不合法。' };
  }
  return {
    ok: true,
    startMs: revision.startMs,
    endMs: revision.endMs,
    label: revision.label.trim(),
  };
}

/**
 * 在原数组中就地替换目标记录的起点、终点与标签，保留同一条记录引用与
 * 其余字段（id、createdAt）。找不到目标时原样返回，绝不新建记录身份。
 */
export function reviseClipInList(
  clips: readonly Clip[],
  id: string,
  revision: ClipRevision,
): Clip[] {
  return clips.map((clip) =>
    clip.id === id ? { ...clip, ...revision } : clip,
  );
}

let idCounter = 0;
export function createClipId(): string {
  idCounter += 1;
  return `clip-${Date.now().toString(36)}-${idCounter}`;
}
