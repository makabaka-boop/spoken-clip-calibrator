import { toMillis } from './time';

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

let idCounter = 0;
export function createClipId(): string {
  idCounter += 1;
  return `clip-${Date.now().toString(36)}-${idCounter}`;
}
