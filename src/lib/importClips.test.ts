import { describe, expect, it } from 'vitest';
import { parseImportPayload, type ImportSuccess } from './importClips';

const FILE = 'sample.wav';
const DURATION = 3250;

/** 构造一份合法导出载荷（默认与导出器输出同形：按起点/终点排序）。 */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    audioFileName: FILE,
    durationMs: DURATION,
    clips: [
      { index: 0, startMs: 100, endMs: 500, durationMs: 400, label: '先导出的片段', createdAt: 1 },
      { index: 1, startMs: 100, endMs: 300, durationMs: 200, label: '同起点更早结束', createdAt: 2 },
      { index: 2, startMs: 2000, endMs: 2500, durationMs: 500, label: '后创建的片段', createdAt: 0 },
    ],
    ...overrides,
  };
}

function importPayload(payload: unknown) {
  return parseImportPayload(JSON.stringify(payload), FILE, DURATION);
}

function expectOk(result: ReturnType<typeof importPayload>): ImportSuccess {
  if (!result.ok) throw new Error(`预期导入成功，实际报错：${result.error}`);
  return result;
}

describe('parseImportPayload 合法载荷', () => {
  it('还原片段：生成页面内 id、保留标签/边界/创建序号，并按创建序号恢复清单顺序', () => {
    const result = expectOk(importPayload(makePayload()));

    expect(result.clips).toHaveLength(3);
    // 导出顺序是按起点/终点；还原后应回到创建顺序（createdAt 0,1,2）
    expect(result.clips.map((c) => c.createdAt)).toEqual([0, 1, 2]);
    expect(result.clips.map((c) => c.label)).toEqual([
      '后创建的片段',
      '先导出的片段',
      '同起点更早结束',
    ]);
    expect(result.clips[0]).toMatchObject({ startMs: 2000, endMs: 2500 });

    // 页面内标识：每条都有 id 且互不相同
    const ids = result.clips.map((c) => c.id);
    for (const id of ids) expect(typeof id).toBe('string');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('后续创建序号接在已有最大值之后（含删除造成的空洞）', () => {
    const result = expectOk(importPayload(makePayload()));
    expect(result.nextCreatedAt).toBe(3);

    const withGaps = expectOk(
      importPayload(
        makePayload({
          clips: [
            { index: 0, startMs: 10, endMs: 20, durationMs: 10, label: '甲', createdAt: 0 },
            { index: 1, startMs: 30, endMs: 40, durationMs: 10, label: '乙', createdAt: 4 },
            { index: 2, startMs: 50, endMs: 60, durationMs: 10, label: '丙', createdAt: 7 },
          ],
        }),
      ),
    );
    expect(withGaps.nextCreatedAt).toBe(8);
  });

  it('空 clips 数组合法：还原为空清单，序号从 0 起', () => {
    const result = expectOk(importPayload(makePayload({ clips: [] })));
    expect(result.clips).toEqual([]);
    expect(result.nextCreatedAt).toBe(0);
  });

  it('标签按导出时一样去除首尾空白', () => {
    const result = expectOk(
      importPayload(
        makePayload({
          clips: [
            { index: 0, startMs: 1, endMs: 2, durationMs: 1, label: '  受访者回忆  ', createdAt: 0 },
          ],
        }),
      ),
    );
    expect(result.clips[0].label).toBe('受访者回忆');
  });
});

describe('parseImportPayload 文件与音频核对', () => {
  it('无法解析的文本报错', () => {
    const result = parseImportPayload('这不是 JSON {{{', FILE, DURATION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('无法解析');
  });

  it('非对象 JSON（数组/标量）报错', () => {
    for (const text of ['[]', '42', '"text"', 'null']) {
      const result = parseImportPayload(text, FILE, DURATION);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('无法解析');
    }
  });

  it('音频文件名不一致报错', () => {
    const result = importPayload(makePayload({ audioFileName: 'other.wav' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('音频不匹配');
      expect(result.error).toContain('other.wav');
      expect(result.error).toContain(FILE);
    }
  });

  it('取整后时长不一致报错', () => {
    const result = importPayload(makePayload({ durationMs: DURATION + 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('音频不匹配');
  });

  it('缺少必要字段时报导出格式错误', () => {
    for (const payload of [
      { durationMs: DURATION, clips: [] },
      { audioFileName: FILE, clips: [] },
      { audioFileName: FILE, durationMs: DURATION },
      { audioFileName: FILE, durationMs: '3250', clips: [] },
    ]) {
      expect(importPayload(payload).ok).toBe(false);
    }
  });
});

describe('parseImportPayload 逐条记录校验（复用毫秒边界规则）', () => {
  const clipWith = (patch: Record<string, unknown>) =>
    makePayload({
      clips: [
        { index: 0, startMs: 100, endMs: 500, durationMs: 400, label: '好记录', createdAt: 0 },
        { index: 1, startMs: 600, endMs: 900, durationMs: 300, label: '坏记录', createdAt: 1, ...patch },
      ],
    });

  it('任一记录越界（终点超过时长）即整体失败并指出第几条', () => {
    const result = importPayload(clipWith({ startMs: 3000, endMs: 3251, durationMs: 251 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('第 2 条记录');
      expect(result.error).toContain('超出音频时长');
    }
  });

  it('相等边界与反向边界被拒绝', () => {
    const equal = importPayload(clipWith({ startMs: 700, endMs: 700, durationMs: 0 }));
    expect(equal.ok).toBe(false);
    if (!equal.ok) expect(equal.error).toContain('相等');

    const reversed = importPayload(clipWith({ startMs: 900, endMs: 600, durationMs: -300 }));
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.error).toContain('反向');
  });

  it('非整数毫秒被拒绝', () => {
    const result = importPayload(clipWith({ startMs: 600.5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('整数毫秒');
  });

  it('空标签被拒绝', () => {
    const result = importPayload(clipWith({ label: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('标签不能为空');
  });

  it('创建序号重复被拒绝', () => {
    const result = importPayload(clipWith({ createdAt: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('创建序号重复');
  });

  it('创建序号为负数或非整数被拒绝', () => {
    for (const createdAt of [-1, 1.5, '2']) {
      const result = importPayload(clipWith({ createdAt }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('创建序号');
    }
  });

  it('创建序号达到或超过安全整数上限被拒绝（后续序号无法可靠续接）', () => {
    for (const createdAt of [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      2 ** 60,
    ]) {
      const result = importPayload(clipWith({ createdAt }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('第 2 条记录');
        expect(result.error).toContain('续接');
      }
    }
  });

  it('安全整数上限减一仍可导入，后续序号接在 MAX_SAFE_INTEGER', () => {
    const result = expectOk(
      importPayload(clipWith({ createdAt: Number.MAX_SAFE_INTEGER - 1 })),
    );
    expect(result.nextCreatedAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('记录不是对象或字段类型错误被拒绝', () => {
    expect(importPayload(makePayload({ clips: [null] })).ok).toBe(false);
    expect(importPayload(makePayload({ clips: ['文本'] })).ok).toBe(false);
    expect(
      importPayload(makePayload({ clips: [{ startMs: '100', endMs: 500, label: '甲', createdAt: 0 }] })).ok,
    ).toBe(false);
    expect(
      importPayload(makePayload({ clips: [{ startMs: 100, endMs: 500, createdAt: 0 }] })).ok,
    ).toBe(false);
  });

  it('失败结果不携带任何片段（不产生部分恢复）', () => {
    const result = importPayload(clipWith({ endMs: 99999 }));
    expect(result.ok).toBe(false);
    expect('clips' in result).toBe(false);
  });
});

describe('校准后的记录导出后再次导入：格式无需升级', () => {
  it('只改起点/终点/标签、保留创建序号的记录可原样恢复并继续排序', () => {
    // 模拟“校准”： createdAt 0 的片段被改到更早的范围与新标签，
    // 载荷形状与未编辑记录完全一致——没有新增/改变任何字段。
    const payload = makePayload({
      clips: [
        { index: 0, startMs: 50, endMs: 300, durationMs: 250, label: '校准后的片段', createdAt: 1 },
        { index: 1, startMs: 2000, endMs: 2500, durationMs: 500, label: '后创建的片段', createdAt: 0 },
      ],
    });
    const result = expectOk(importPayload(payload));
    expect(result.clips).toHaveLength(2);
    // 按创建序号还原清单顺序，校准没有重建记录身份（序号仍是 1）
    expect(result.clips.map((c) => c.createdAt)).toEqual([0, 1]);
    expect(result.clips[1]).toMatchObject({
      startMs: 50,
      endMs: 300,
      label: '校准后的片段',
      createdAt: 1,
    });
    expect(result.nextCreatedAt).toBe(2);
  });
});
