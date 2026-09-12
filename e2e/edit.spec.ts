import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ASSETS = join(process.cwd(), 'test-assets');

interface ExportedClipRecord {
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  label: string;
  createdAt: number;
}

interface ExportPayloadShape {
  audioFileName: string;
  durationMs: number;
  clips: ExportedClipRecord[];
}

async function loadFile(page: Page, fileName: string) {
  const buffer = await readFile(join(ASSETS, fileName));
  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: fileName,
    mimeType: fileName.endsWith('.wav') ? 'audio/wav' : 'text/plain',
    buffer,
  });
}

async function importJson(page: Page, name: string, content: string | Buffer) {
  await page.locator('[data-testid="import-input"]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
  });
}

async function addClipViaUi(page: Page, startSec: number, endSec: number, label: string) {
  const audio = page.locator('[data-testid="audio-element"]');
  await audio.evaluate((el: HTMLAudioElement, t: number) => {
    el.currentTime = t;
  }, startSec);
  await page.waitForTimeout(120);
  await page.locator('[data-testid="capture-start"]').click();
  await audio.evaluate((el: HTMLAudioElement, t: number) => {
    el.currentTime = t;
  }, endSec);
  await page.waitForTimeout(120);
  await page.locator('[data-testid="capture-end"]').click();
  await page.locator('[data-testid="label-input"]').fill(label);
  await page.locator('[data-testid="add-clip"]').click();
  // 加入后该记录自动选中；等选择生效，避免与紧随其后的点击竞争。
  const count = await page.locator('[data-testid="clip-item"]').count();
  await expect(page.locator('[data-testid="clip-item"]').nth(count - 1)).toHaveClass(
    /selected/,
  );
}

async function exportAndRead(page: Page): Promise<ExportPayloadShape> {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-testid="export-json"]').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ExportPayloadShape;
}

async function currentMs(page: Page): Promise<number> {
  const text = await page.locator('[data-testid="current-ms"]').textContent();
  return Number((text ?? '').replace(/[^\d-]/g, ''));
}

function readBounds(text: string | null): { startMs: number; endMs: number } {
  return {
    startMs: Number(text?.match(/^(\d+) ms/)?.[1] ?? 'NaN'),
    endMs: Number(text?.match(/→ (\d+) ms/)?.[1] ?? 'NaN'),
  };
}

test.beforeEach(async ({ page }) => {
  // 纯前端红线：除 data:/blob:/同源页面资源外，任何外部网络请求都视为失败。
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (
      url.startsWith('http://127.0.0.1:4173') ||
      url.startsWith('blob:') ||
      url.startsWith('data:')
    ) {
      return route.continue();
    }
    throw new Error(`检测到非本地请求，违反纯前端约束: ${url}`);
  });
  await page.goto('/');
  await loadFile(page, 'sample.wav');
  await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();
});

test('选中片段 → 校准 → 保存后仍选中、按新范围循环试听（到修订终点复位到新起点）', async ({
  page,
}) => {
  const audio = page.locator('[data-testid="audio-element"]');
  // 两条片段；校准 createdAt 0 的第一条
  await addClipViaUi(page, 0.5, 1.4, '片段甲：原始范围');
  await addClipViaUi(page, 2.0, 2.5, '片段乙：保持不动');
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);

  const items = page.locator('[data-testid="clip-item"]');
  const first = items.nth(0);
  const second = items.nth(1);
  // 新增会选中最新一条；校准第一条前显式选中它
  await first.locator('[data-testid="clip-select"]').check();
  await expect(first).toHaveClass(/selected/);
  await expect(second).not.toHaveClass(/selected/);
  const before = readBounds(await first.locator('[data-testid="clip-bounds"]').textContent());
  await expect(page.locator('[data-testid="selected-created-at"]')).toHaveText(
    '已选片段创建序号：0',
  );

  // 入口：选中片段后进入单一编辑态，表单预填原标签与整数毫秒边界
  await page.locator('[data-testid="edit-selected-clip"]').click();
  const editor = page.locator('[data-testid="clip-editor"]');
  await expect(editor).toBeVisible();
  await expect(page.locator('[data-testid="edit-label-input"]')).toHaveValue('片段甲：原始范围');
  await expect(page.locator('[data-testid="edit-start-input"]')).toHaveValue(String(before.startMs));
  await expect(page.locator('[data-testid="edit-end-input"]')).toHaveValue(String(before.endMs));

  // 改为 600–1100 ms 与新标签
  await page.locator('[data-testid="edit-start-input"]').fill('600');
  await page.locator('[data-testid="edit-end-input"]').fill('1100');
  await page.locator('[data-testid="edit-label-input"]').fill('片段甲：校准范围');

  // 记录 play 事件，验证保存后立即试听
  await audio.evaluate((el: HTMLAudioElement) => {
    (window as unknown as { __plays: number }).__plays = 0;
    el.addEventListener('play', () => {
      (window as unknown as { __plays: number }).__plays += 1;
    });
  });

  await page.locator('[data-testid="save-clip-edit"]').click();

  // 退出编辑态，记录仍被选中，创建序号不变
  await expect(editor).toHaveCount(0);
  await expect(first).toHaveClass(/selected/);
  await expect(second).not.toHaveClass(/selected/);
  await expect(page.locator('[data-testid="selected-created-at"]')).toHaveText(
    '已选片段创建序号：0',
  );
  await expect(first.locator('[data-testid="clip-label"]')).toHaveText('片段甲：校准范围');
  const after = readBounds(await first.locator('[data-testid="clip-bounds"]').textContent());
  expect(after.startMs).toBe(600);
  expect(after.endMs).toBe(1100);
  await expect(page.locator('[data-testid="edit-error"]')).toHaveCount(0);

  // 保存后立即按新范围循环试听：从新起点开始
  await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
  await expect
    .poll(() => currentMs(page), { timeout: 3000, intervals: [16] })
    .toBeGreaterThanOrEqual(600);

  // 首次达到修订终点 1100：暂停并复位到修订起点 600（容差 1ms），而非旧范围
  await expect
    .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), {
      timeout: 5000,
      intervals: [16],
    })
    .toBe(true);
  const backAtStart = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
  expect(Math.abs(backAtStart - 600)).toBeLessThanOrEqual(1);

  // 自动再循环：确实再次播放
  await expect
    .poll(
      async () => page.evaluate(() => (window as unknown as { __plays: number }).__plays),
      { timeout: 3000, intervals: [30] },
    )
    .toBeGreaterThanOrEqual(2);
});

test('非法保存：空标签 / 相等 / 反向 / 越界在编辑区指出原因，旧记录不被部分改写，播放位置与原试听范围不变', async ({
  page,
}) => {
  const audio = page.locator('[data-testid="audio-element"]');
  await addClipViaUi(page, 0.5, 1.4, '待校准片段');
  const item = page.locator('[data-testid="clip-item"]').first();
  const originalBoundsText = await item.locator('[data-testid="clip-bounds"]').textContent();
  const original = readBounds(originalBoundsText);

  // 先按原范围进入循环试听，随后停止并停在一个可识别的位置
  await item.locator('[data-testid="audition-clip"]').click();
  await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
  await item.locator('[data-testid="stop-audition"]').click();
  await expect(page.locator('[data-testid="audition-badge"]')).toHaveCount(0);

  // 进入校准编辑态
  await page.locator('[data-testid="edit-selected-clip"]').click();
  const editor = page.locator('[data-testid="clip-editor"]');
  await expect(editor).toBeVisible();

  async function expectRejected(
    startMs: string,
    endMs: string,
    label: string,
    reason: RegExp,
  ) {
    await page.locator('[data-testid="edit-start-input"]').fill(startMs);
    await page.locator('[data-testid="edit-end-input"]').fill(endMs);
    await page.locator('[data-testid="edit-label-input"]').fill(label);
    await page.locator('[data-testid="save-clip-edit"]').click();
    await expect(page.locator('[data-testid="edit-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="edit-error"]')).toContainText(reason);

    // 失败：编辑态保留，清单中的旧记录未被部分改写
    await expect(editor).toBeVisible();
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
    await expect(item.locator('[data-testid="clip-label"]')).toHaveText('待校准片段');
    await expect(item.locator('[data-testid="clip-bounds"]')).toHaveText(
      new RegExp(`${original.startMs} ms → ${original.endMs} ms`),
    );
    // 记录仍被选中，播放停在精确的原起点，原试听范围没有被新值替换
    await expect(item).toHaveClass(/selected/);
    const posMs = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    expect(Math.abs(posMs - original.startMs)).toBeLessThanOrEqual(1);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    await expect(page.locator('[data-testid="audition-badge"]')).toHaveCount(0);
  }

  // 空标签
  await expectRejected('600', '1100', '   ', /标签不能为空/);
  // 相等边界
  await expectRejected('900', '900', '校准后', /相等/);
  // 反向边界
  await expectRejected('1200', '800', '校准后', /反向/);
  // 超出音频时长（音频 3250 ms）
  await expectRejected('3000', '3251', '校准后', /超出音频时长/);

  // 失败期间表单输入都还在，用户修正后可再次提交成功
  await page.locator('[data-testid="edit-start-input"]').fill('700');
  await page.locator('[data-testid="edit-end-input"]').fill('1000');
  await page.locator('[data-testid="edit-label-input"]').fill('校准后');
  await page.locator('[data-testid="save-clip-edit"]').click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-testid="edit-error"]')).toHaveCount(0);
  await expect(item.locator('[data-testid="clip-label"]')).toHaveText('校准后');
  const fixed = readBounds(await item.locator('[data-testid="clip-bounds"]').textContent());
  expect(fixed).toEqual({ startMs: 700, endMs: 1000 });
  // 修正成功后立即按新范围试听并复位到新起点
  await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
  await expect
    .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), {
      timeout: 5000,
      intervals: [16],
    })
    .toBe(true);
  const back = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
  expect(Math.abs(back - 700)).toBeLessThanOrEqual(1);
});

test('校准保存后下载复算：排序、时长、创建序号按修订值，未编辑记录不变', async ({ page }) => {
  // 故意让被校准记录在保存后改变导出排序中的位置
  await addClipViaUi(page, 2.0, 2.5, '后创建的片段'); // createdAt 0
  await addClipViaUi(page, 0.2, 0.8, '先导出的片段'); // createdAt 1
  await addClipViaUi(page, 0.2, 0.5, '同起点更早结束'); // createdAt 2

  // 校准 createdAt 2 的记录（当前清单第 3 条）：改为更早的起点
  const items = page.locator('[data-testid="clip-item"]');
  await items.nth(2).locator('[data-testid="clip-select"]').check();
  await page.locator('[data-testid="edit-selected-clip"]').click();
  await page.locator('[data-testid="edit-start-input"]').fill('50');
  await page.locator('[data-testid="edit-end-input"]').fill('250');
  await page.locator('[data-testid="edit-label-input"]').fill('校准后排最前');
  await page.locator('[data-testid="save-clip-edit"]').click();

  // 保存即触发试听，停止后再下载
  await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
  await page
    .locator('[data-testid="clip-item"]')
    .nth(2)
    .locator('[data-testid="stop-audition"]')
    .click();

  const payload = await exportAndRead(page);
  expect(payload.audioFileName).toBe('sample.wav');
  expect(payload.durationMs).toBe(3250);
  expect(payload.clips).toHaveLength(3);

  // 校准后的记录（createdAt 仍为 2）因起点 50 排在最前
  const edited = payload.clips[0];
  expect(edited).toMatchObject({
    index: 0,
    startMs: 50,
    endMs: 250,
    durationMs: 200,
    label: '校准后排最前',
    createdAt: 2,
  });
  // 未编辑的两条记录原样保留，且排序规则不变
  expect(payload.clips.slice(1).map((c) => c.label)).toEqual(['先导出的片段', '后创建的片段']);
  for (const [i, c] of payload.clips.entries()) {
    expect(c.index).toBe(i);
    expect(c.durationMs).toBe(c.endMs - c.startMs);
    expect(Number.isInteger(c.startMs)).toBe(true);
    expect(Number.isInteger(c.endMs)).toBe(true);
    expect(c.startMs).toBeGreaterThanOrEqual(0);
    expect(c.startMs).toBeLessThan(c.endMs);
    expect(c.endMs).toBeLessThanOrEqual(payload.durationMs);
    expect(c.label.trim().length).toBeGreaterThan(0);
  }

  // 再次导入：校准后的记录无需格式升级即可恢复，创建序号 0/1/2 齐全
  await page.reload();
  await loadFile(page, 'sample.wav');
  await importJson(page, 'sample.clips.json', JSON.stringify(payload));
  const restored = page.locator('[data-testid="clip-item"]');
  await expect(restored).toHaveCount(3);
  // 按创建序号恢复清单顺序；被校准记录是 createdAt 2，在清单末尾
  await expect(restored.nth(0).locator('[data-testid="clip-label"]')).toHaveText('后创建的片段');
  await expect(restored.nth(1).locator('[data-testid="clip-label"]')).toHaveText('先导出的片段');
  await expect(restored.nth(2).locator('[data-testid="clip-label"]')).toHaveText('校准后排最前');
  const restoredBounds = readBounds(
    await restored.nth(2).locator('[data-testid="clip-bounds"]').textContent(),
  );
  expect(restoredBounds).toEqual({ startMs: 50, endMs: 250 });
  await expect(page.locator('[data-testid="error"]')).toHaveCount(0);

  // 恢复后续加片段，序号仍可靠接在最大值 2 之后
  await addClipViaUi(page, 1.0, 1.3, '恢复后续加');
  await expect(page.locator('[data-testid="selected-created-at"]')).toHaveText(
    '已选片段创建序号：3',
  );
});

test('原有新增、删除、取消校准与未编辑记录的导入恢复保持可用', async ({ page }) => {
  // 取消校准：不改动记录
  await addClipViaUi(page, 0.3, 0.9, '会取消校准的片段');
  const item = page.locator('[data-testid="clip-item"]').first();
  const before = readBounds(await item.locator('[data-testid="clip-bounds"]').textContent());
  await page.locator('[data-testid="edit-selected-clip"]').click();
  await page.locator('[data-testid="edit-start-input"]').fill('100');
  await page.locator('[data-testid="edit-label-input"]').fill('改了但取消');
  await page.locator('[data-testid="cancel-clip-edit"]').click();
  await expect(page.locator('[data-testid="clip-editor"]')).toHaveCount(0);
  await expect(item.locator('[data-testid="clip-label"]')).toHaveText('会取消校准的片段');
  await expect(item.locator('[data-testid="clip-bounds"]')).toHaveText(
    new RegExp(`${before.startMs} ms → ${before.endMs} ms`),
  );

  // 删除在编辑态之外仍然可用
  await item.locator('[data-testid="delete-clip"]').click();
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(0);

  // 新增仍可用：两条记录（一条保持不编辑），导出后在新会话恢复
  await addClipViaUi(page, 0.2, 0.6, '保持不编辑');
  await addClipViaUi(page, 1.0, 1.4, '会校准的一条');
  const items = page.locator('[data-testid="clip-item"]');
  await items.nth(1).locator('[data-testid="clip-select"]').check();
  await page.locator('[data-testid="edit-selected-clip"]').click();
  await page.locator('[data-testid="edit-end-input"]').fill('1500');
  await page.locator('[data-testid="save-clip-edit"]').click();
  await page
    .locator('[data-testid="clip-item"]')
    .nth(1)
    .locator('[data-testid="stop-audition"]')
    .click();
  const payload = await exportAndRead(page);

  await page.reload();
  await loadFile(page, 'sample.wav');
  await importJson(page, 'session.clips.json', JSON.stringify(payload));
  const restored = page.locator('[data-testid="clip-item"]');
  await expect(restored).toHaveCount(2);
  // 未编辑记录与被校准记录都按创建顺序、原值恢复
  const untouched = readBounds(await restored.nth(0).locator('[data-testid="clip-bounds"]').textContent());
  expect(untouched).toEqual({ startMs: payload.clips.find((c) => c.label === '保持不编辑')!.startMs, endMs: payload.clips.find((c) => c.label === '保持不编辑')!.endMs });
  const edited = readBounds(await restored.nth(1).locator('[data-testid="clip-bounds"]').textContent());
  expect(edited.endMs).toBe(1500);
  await expect(restored.nth(0)).toHaveClass(/selected/);
});
