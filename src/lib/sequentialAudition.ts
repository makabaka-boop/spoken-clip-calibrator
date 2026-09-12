import { sortClipsForExport, type Clip } from './clips';

/**
 * 顺序审听会话只在三种状态间流转：
 * - idle（空闲）：未在顺序审听（收束 / 停止 / 被拒绝播放后都回到空闲）；
 * - playing（播放当前片段）：从当前片段的精确起点播放，逐帧等待整数毫秒达到终点；
 * - switching（切换下一片段）：当前片段到终点后已暂停复位，稍后选中并播放下一条。
 *
 * 排序与导出完全一致（起点 → 终点 → 创建序号），本模块只做纯状态推演，
 * 不触碰媒体元素：毫秒换算、Clip 与定位/播放由调用方复用既有控制完成。
 */
export type SequentialPhase = 'idle' | 'playing' | 'switching';

export interface SequentialSession {
  phase: SequentialPhase;
  /** 按导出排序后，从起点片段到末条的 id 队列（idle 时仍保留，用于定位游标停留片段）。 */
  queue: readonly string[];
  /** queue 中当前片段的位置；收束/停止后指向游标应停留的片段。 */
  index: number;
}

export const IDLE_SEQUENTIAL_SESSION: SequentialSession = {
  phase: 'idle',
  queue: [],
  index: 0,
};

/**
 * 从选中记录开始顺序审听：取导出排序中该记录及其后续全部记录的 id。
 * 未选择或清单中找不到该记录时返回 null（入口此时本应不可用）。
 */
export function buildSequentialQueue(
  clips: readonly Clip[],
  selectedId: string | null,
): string[] | null {
  if (!selectedId) return null;
  const sorted = sortClipsForExport(clips);
  const position = sorted.findIndex((clip) => clip.id === selectedId);
  if (position === -1) return null;
  return sorted.slice(position).map((clip) => clip.id);
}

/** 会话开始：从队列首条（即当前选中记录）的“播放当前片段”状态起步。 */
export function startSequentialSession(queue: readonly string[]): SequentialSession | null {
  if (queue.length === 0) return null;
  return { phase: 'playing', queue, index: 0 };
}

export function isSequentialLastClip(session: SequentialSession): boolean {
  return session.index >= session.queue.length - 1;
}

/** 当前（空闲收束后仍可读取的）游标停留片段 id。 */
export function currentSequentialId(session: SequentialSession): string | null {
  return session.queue[session.index] ?? null;
}

/**
 * 当前片段首次观测到整数毫秒达到终点、媒体已暂停复位后调用：
 * - 不是末条 → switching：停在当前片段起点，下一步选中并播放下一条；
 * - 末条 → idle 收束：停在末条起点并退出顺序审听。
 * 非播放状态下原样返回，杜绝重复触发。
 */
export function clipReachedEnd(session: SequentialSession): SequentialSession {
  if (session.phase !== 'playing') return session;
  if (isSequentialLastClip(session)) {
    return { ...session, phase: 'idle' };
  }
  return { ...session, phase: 'switching' };
}

/** switching → playing：选中并开始播放下一条（index 前移一位）。 */
export function beginNextClip(session: SequentialSession): SequentialSession {
  if (session.phase !== 'switching') return session;
  return { ...session, phase: 'playing', index: session.index + 1 };
}

/**
 * 中途停止：退出顺序审听。index 不前移——调用方据此把游标定位回当前片段
 * （切换停留期间停止则停在刚播完的片段）的精确起点。
 */
export function stopSequentialSession(session: SequentialSession): SequentialSession {
  if (session.phase === 'idle') return session;
  return { ...session, phase: 'idle' };
}
