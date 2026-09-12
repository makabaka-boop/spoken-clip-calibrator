import { describe, expect, it } from 'vitest';
import type { Clip } from './clips';
import {
  IDLE_SEQUENTIAL_SESSION,
  beginNextClip,
  buildSequentialQueue,
  clipReachedEnd,
  currentSequentialId,
  isSequentialLastClip,
  startSequentialSession,
  stopSequentialSession,
} from './sequentialAudition';

const clip = (startMs: number, endMs: number, createdAt: number, label: string): Clip => ({
  id: `c${createdAt}`,
  startMs,
  endMs,
  createdAt,
  label,
});

// 清单按创建顺序排列，故意与导出（起点→终点→创建序号）顺序不同。
// 导出顺序：乙(100–300) → 丁(100–500) → 丙(1000–1200) → 甲(2000–2500)
const clips = [
  clip(2000, 2500, 0, '甲'),
  clip(100, 300, 1, '乙'),
  clip(1000, 1200, 2, '丙'),
  clip(100, 500, 3, '丁'),
];

describe('buildSequentialQueue 顺序审听队列', () => {
  it('按导出排序取选中记录及其后续记录，且不改变原清单', () => {
    const queue = buildSequentialQueue(clips, clips[2].id); // 选中“丙”
    expect(queue).toEqual(['c2', 'c0']); // 丙（1000 起）→ 甲（2000 起）
    expect(clips.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('同起点按终点、再按创建序号排序；选中首条时覆盖全部排序结果', () => {
    const queue = buildSequentialQueue(clips, clips[1].id); // 选中“乙”
    expect(queue).toEqual(['c1', 'c3', 'c2', 'c0']);
  });

  it('选中末条时队列只有该条', () => {
    const queue = buildSequentialQueue(clips, clips[0].id); // 选中“甲”
    expect(queue).toEqual(['c0']);
  });

  it('未选择记录时不可开始', () => {
    expect(buildSequentialQueue(clips, null)).toBeNull();
    expect(startSequentialSession([])).toBeNull();
  });

  it('选择的 id 不在清单中时不可开始', () => {
    expect(buildSequentialQueue(clips, 'missing')).toBeNull();
  });

  it('空清单入口不可用', () => {
    expect(buildSequentialQueue([], clips[0].id)).toBeNull();
  });
});

describe('排序后的推进（playing → switching → playing）', () => {
  it('当前片段到终点后暂停复位并切换，下一片段选中并播放，index 顺序前移', () => {
    const queue = buildSequentialQueue(clips, clips[1].id)!;
    let session = startSequentialSession(queue)!;
    expect(session.phase).toBe('playing');
    expect(currentSequentialId(session)).toBe('c1');
    expect(isSequentialLastClip(session)).toBe(false);

    // 第一条（乙）到终点：进入切换态，游标仍停在乙的起点
    session = clipReachedEnd(session);
    expect(session.phase).toBe('switching');
    expect(session.index).toBe(0);
    expect(currentSequentialId(session)).toBe('c1');

    // 切换并播放下一条（丁）
    session = beginNextClip(session);
    expect(session.phase).toBe('playing');
    expect(session.index).toBe(1);
    expect(currentSequentialId(session)).toBe('c3');

    // 丁到终点 → 丙
    session = beginNextClip(clipReachedEnd(session));
    expect(session.phase).toBe('playing');
    expect(currentSequentialId(session)).toBe('c2');

    // 丙到终点 → 甲
    session = beginNextClip(clipReachedEnd(session));
    expect(session.phase).toBe('playing');
    expect(currentSequentialId(session)).toBe('c0');
    expect(isSequentialLastClip(session)).toBe(true);
  });

  it('到终点的推进在播放态之外不重复触发', () => {
    const queue = buildSequentialQueue(clips, clips[2].id)!;
    const playing = startSequentialSession(queue)!;
    const switching = clipReachedEnd(playing);
    expect(clipReachedEnd(switching)).toBe(switching);
    // 非切换态不能直接前移
    expect(beginNextClip(playing)).toBe(playing);
  });
});

describe('末条收束', () => {
  it('末条到终点后回到空闲并停在末条起点，不产生额外切换', () => {
    const queue = buildSequentialQueue(clips, clips[0].id)!; // 只含末条“甲”
    let session = startSequentialSession(queue)!;
    expect(isSequentialLastClip(session)).toBe(true);

    session = clipReachedEnd(session);
    expect(session.phase).toBe('idle');
    expect(currentSequentialId(session)).toBe('c0');
    // 空闲态不会再前移
    expect(beginNextClip(session)).toBe(session);
    expect(clipReachedEnd(session)).toBe(session);
  });

  it('多片段会话推进到最后一条后收束', () => {
    const queue = buildSequentialQueue(clips, clips[2].id)!; // 丙 → 甲
    let session = startSequentialSession(queue)!;
    session = clipReachedEnd(session); // 丙到终点
    expect(session.phase).toBe('switching');
    session = beginNextClip(session); // 播放甲
    expect(currentSequentialId(session)).toBe('c0');
    session = clipReachedEnd(session); // 甲（末条）到终点
    expect(session.phase).toBe('idle');
    expect(currentSequentialId(session)).toBe('c0');
    expect(session.index).toBe(1);
  });
});

describe('中途停止', () => {
  it('播放当前片段时停止：空闲且 index 不前移，游标停在当前片段起点', () => {
    const queue = buildSequentialQueue(clips, clips[1].id)!;
    let session = startSequentialSession(queue)!;
    session = beginNextClip(clipReachedEnd(session)); // 正在播放第二条“丁”
    expect(currentSequentialId(session)).toBe('c3');

    const stopped = stopSequentialSession(session);
    expect(stopped.phase).toBe('idle');
    expect(stopped.index).toBe(1);
    expect(currentSequentialId(stopped)).toBe('c3');
    // 已空闲时停止是幂等的
    expect(stopSequentialSession(stopped)).toBe(stopped);
  });

  it('切换停留期间停止：停在刚播完片段（index 不前移），退出顺序审听', () => {
    const queue = buildSequentialQueue(clips, clips[1].id)!;
    let session = startSequentialSession(queue)!;
    session = clipReachedEnd(session); // 乙播完，正准备切换到丁
    expect(session.phase).toBe('switching');

    const stopped = stopSequentialSession(session);
    expect(stopped.phase).toBe('idle');
    expect(stopped.index).toBe(0);
    expect(currentSequentialId(stopped)).toBe('c1');
  });

  it('初始空闲会话为空闲态且无当前片段', () => {
    expect(IDLE_SEQUENTIAL_SESSION.phase).toBe('idle');
    expect(currentSequentialId(IDLE_SEQUENTIAL_SESSION)).toBeNull();
  });
});
