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
}

async function exportAndRead(page: Page): Promise<{ payload: ExportPayloadShape; buffer: Buffer }> {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-testid="export-json"]').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buffer = Buffer.concat(chunks);
  return { payload: JSON.parse(buffer.toString('utf8')) as ExportPayloadShape, buffer };
}

async function currentMs(page: Page): Promise<number> {
  const text = await page.locator('[data-testid="current-ms"]').textContent();
  return Number((text ?? '').replace(/[^\d-]/g, ''));
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
});

test('重新打开页面后导入昨日导出文件：恢复清单、续加序号、试听复位、再次导出', async ({
  page,
}) => {
  await page.goto('/');
  await loadFile(page, 'sample.wav');
  await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();

  // 昨日工作：两条片段（创建顺序与导出排序不同，便于验证恢复顺序）
  await addClipViaUi(page, 2.0, 2.5, '后创建的片段'); // createdAt 0
  await addClipViaUi(page, 0.2, 0.8, '先导出的片段'); // createdAt 1
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);
  const { payload: exported, buffer: exportedBuffer } = await exportAndRead(page);
  expect(exported.clips).toHaveLength(2);

  // 重新打开页面（全新会话），载入同一段原音频
  await page.reload();
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(0);
  await loadFile(page, 'sample.wav');
  await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();

  // 选择此前导出的片段 JSON：校验通过后一次性恢复清单
  await importJson(page, 'sample.clips.json', exportedBuffer);
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="error"]')).toHaveCount(0);

  const items = page.locator('[data-testid="clip-item"]');
  // 按创建顺序恢复（导出文件是按起点/终点排序的），首条被选中
  await expect(items.nth(0).locator('[data-testid="clip-label"]')).toHaveText('后创建的片段');
  await expect(items.nth(1).locator('[data-testid="clip-label"]')).toHaveText('先导出的片段');
  await expect(items.nth(0)).toHaveClass(/selected/);
  await expect(items.nth(1)).not.toHaveClass(/selected/);
  await expect(page.locator('[data-testid="selected-created-at"]')).toHaveText(
    '已选片段创建序号：0',
  );

  // 恢复记录的边界与昨日导出内容一致（导出文件按起点排序，后创建的片段在 index 1）
  const exportedA = exported.clips.find((c) => c.label === '后创建的片段');
  expect(exportedA).toBeDefined();
  const boundsText = (await items.nth(0).locator('[data-testid="clip-bounds"]').textContent()) ?? '';
  const startA = Number(boundsText.match(/^(\d+) ms/)?.[1] ?? 'NaN');
  const endA = Number(boundsText.match(/→ (\d+) ms/)?.[1] ?? 'NaN');
  expect(startA).toBe(exportedA?.startMs);
  expect(endA).toBe(exportedA?.endMs);

  // 续加一条：创建序号接在已有最大值（1）之后
  await addClipViaUi(page, 1.0, 1.5, '续加的片段');
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="selected-created-at"]')).toHaveText(
    '已选片段创建序号：2',
  );

  // 试听恢复的片段：到记录终点暂停并精确回到记录起点
  const audio = page.locator('[data-testid="audio-element"]');
  await items.nth(0).locator('[data-testid="audition-clip"]').click();
  await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
  await expect
    .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), {
      timeout: 5000,
      intervals: [16],
    })
    .toBe(true);
  const backAtStart = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
  expect(Math.abs(backAtStart - startA)).toBeLessThanOrEqual(1);
  await items.nth(0).locator('[data-testid="stop-audition"]').click();
  await expect(page.locator('[data-testid="audition-badge"]')).toHaveCount(0);
  const afterStop = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
  expect(Math.abs(afterStop - startA)).toBeLessThanOrEqual(1);

  // 再次导出：三条片段齐全，创建序号 0/1/2 连续接上，记录可复算
  const { payload: reexported } = await exportAndRead(page);
  expect(reexported.audioFileName).toBe('sample.wav');
  expect(reexported.durationMs).toBe(3250);
  expect(reexported.clips).toHaveLength(3);
  const byLabel = new Map(reexported.clips.map((c) => [c.label, c]));
  expect(byLabel.get('后创建的片段')?.createdAt).toBe(0);
  expect(byLabel.get('先导出的片段')?.createdAt).toBe(1);
  expect(byLabel.get('续加的片段')?.createdAt).toBe(2);
  for (const [i, c] of reexported.clips.entries()) {
    expect(c.index).toBe(i);
    expect(c.durationMs).toBe(c.endMs - c.startMs);
    expect(c.startMs).toBeGreaterThanOrEqual(0);
    expect(c.startMs).toBeLessThan(c.endMs);
    expect(c.endMs).toBeLessThanOrEqual(reexported.durationMs);
  }
});

test('损坏或不匹配的导入文件就地报错，清单、选择与播放位置均不变', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, 'sample.wav');
  await addClipViaUi(page, 0.2, 0.8, '现有片段');
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
  const item = page.locator('[data-testid="clip-item"]').first();
  await expect(item).toHaveClass(/selected/);

  // 停在一个可识别的播放位置（暂停态），失败的导入不得改动它
  const audio = page.locator('[data-testid="audio-element"]');
  await audio.evaluate((el: HTMLAudioElement) => {
    el.currentTime = 1.5;
  });
  await expect
    .poll(() => currentMs(page), { timeout: 3000, intervals: [16] })
    .toBeGreaterThanOrEqual(1470);

  const validPayload = {
    audioFileName: 'sample.wav',
    durationMs: 3250,
    clips: [
      { index: 0, startMs: 100, endMs: 400, durationMs: 300, label: '另一条', createdAt: 0 },
      { index: 1, startMs: 1000, endMs: 1400, durationMs: 400, label: '再一条', createdAt: 1 },
    ],
  };

  async function expectSessionIntact() {
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="clip-label"]')).toHaveText('现有片段');
    await expect(item).toHaveClass(/selected/);
    const pos = await currentMs(page);
    expect(pos).toBeGreaterThanOrEqual(1470);
    expect(pos).toBeLessThanOrEqual(1530);
  }

  // 1) 无法解析的损坏文件
  await importJson(page, 'broken.clips.json', '这不是 JSON {{{');
  await expect(page.locator('[data-testid="error"]')).toContainText('无法解析');
  await expectSessionIntact();

  // 2) 音频文件名不匹配
  await importJson(
    page,
    'wrong-audio.clips.json',
    JSON.stringify({ ...validPayload, audioFileName: 'other.wav' }),
  );
  await expect(page.locator('[data-testid="error"]')).toContainText('音频不匹配');
  await expectSessionIntact();

  // 3) 取整后时长不匹配
  await importJson(
    page,
    'wrong-duration.clips.json',
    JSON.stringify({ ...validPayload, durationMs: 3000 }),
  );
  await expect(page.locator('[data-testid="error"]')).toContainText('音频不匹配');
  await expectSessionIntact();

  // 4) 任一记录越界（终点超出时长）
  await importJson(
    page,
    'out-of-range.clips.json',
    JSON.stringify({
      ...validPayload,
      clips: [
        validPayload.clips[0],
        { index: 1, startMs: 3000, endMs: 9999, durationMs: 6999, label: '越界', createdAt: 1 },
      ],
    }),
  );
  await expect(page.locator('[data-testid="error"]')).toContainText('超出音频时长');
  await expectSessionIntact();

  // 5) 创建序号重复
  await importJson(
    page,
    'duplicate-created-at.clips.json',
    JSON.stringify({
      ...validPayload,
      clips: [validPayload.clips[0], { ...validPayload.clips[1], createdAt: 0 }],
    }),
  );
  await expect(page.locator('[data-testid="error"]')).toContainText('创建序号重复');
  await expectSessionIntact();

  // 连续失败后导入功能本身不受影响：合法文件仍可一次性替换恢复
  await importJson(page, 'valid.clips.json', JSON.stringify(validPayload));
  await expect(page.locator('[data-testid="error"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="clip-item"]').first()).toHaveClass(/selected/);
  await expect(
    page.locator('[data-testid="clip-item"]').first().locator('[data-testid="clip-label"]'),
  ).toHaveText('另一条');
});

test('读取与校验期间显示处理中并禁用导入输入，结束后恢复', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, 'sample.wav');
  await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();

  // 处理窗口可能短到无法从测试侧轮询（解析时主线程被占满），
  // 因此在页面内用 MutationObserver 如实记录导入状态的每次变迁。
  await page.evaluate(() => {
    const w = window as unknown as {
      __importStates: Array<{ status: boolean; disabled: boolean }>;
    };
    w.__importStates = [];
    const sample = () => {
      w.__importStates.push({
        status: Boolean(document.querySelector('[data-testid="import-status"]')),
        disabled: (document.querySelector('[data-testid="import-input"]') as HTMLInputElement)
          .disabled,
      });
    };
    new MutationObserver(sample).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
  });

  await importJson(page, 'broken.clips.json', '这不是 JSON {{{');
  await expect(page.locator('[data-testid="error"]')).toContainText('无法解析');

  // 处理期间确实出现过「状态可见 + 导入输入禁用」
  const states = await page.evaluate(
    () =>
      (window as unknown as { __importStates: Array<{ status: boolean; disabled: boolean }> })
        .__importStates,
  );
  expect(states.some((s) => s.status && s.disabled)).toBe(true);

  // 处理结束：状态复原，清单仍为空
  await expect(page.locator('[data-testid="import-status"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="import-input"]')).toBeEnabled();
  await expect(page.locator('[data-testid="empty-list"]')).toBeVisible();
});
