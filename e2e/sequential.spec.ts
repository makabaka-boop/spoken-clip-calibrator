import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ASSETS = join(process.cwd(), 'test-assets');

async function loadFile(page: Page, fileName: string) {
  const buffer = await readFile(join(ASSETS, fileName));
  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: fileName,
    mimeType: 'audio/wav',
    buffer,
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
  const count = await page.locator('[data-testid="clip-item"]').count();
  await expect(page.locator('[data-testid="clip-item"]').nth(count - 1)).toHaveClass(
    /selected/,
  );
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

async function isPaused(page: Page): Promise<boolean> {
  return page
    .locator('[data-testid="audio-element"]')
    .evaluate((el: HTMLAudioElement) => el.paused);
}

async function positionMs(page: Page): Promise<number> {
  return page
    .locator('[data-testid="audio-element"]')
    .evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
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

test.describe('顺序审听', () => {
  test('入口在空清单或未选择记录时不可用，选中后可用', async ({ page }) => {
    const entry = page.locator('[data-testid="sequential-audition"]');
    await expect(entry).toBeDisabled();

    // 清单按创建顺序：甲(2000–2500)、乙(200–600)、丙(800–1300)
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    await addClipViaUi(page, 0.2, 0.6, '乙：前段');
    await addClipViaUi(page, 0.8, 1.3, '丙：中段');
    // 新增自动选中最新一条，入口可用
    await expect(entry).toBeEnabled();

    // 删除被选中的记录后无选择，入口再次不可用；重新选中后恢复
    await page.locator('[data-testid="clip-item"]').nth(2).locator('[data-testid="delete-clip"]').click();
    await expect(entry).toBeDisabled();
    await page.locator('[data-testid="clip-item"]').nth(0).locator('[data-testid="clip-select"]').check();
    await expect(entry).toBeEnabled();
  });

  test('从选中记录开始只依次审听排序中的当前项与后续项，选择随播放推进，末条结束精确复位并退出', async ({
    page,
  }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    // 创建顺序与导出（起点→终点→创建序号）顺序不同：
    // 清单：甲(2000–2500, nth0)、乙(200–600, nth1)、丙(800–1300, nth2)
    // 排序：乙 → 丙 → 甲。选中排序中间项“丙”，队列应为 丙 → 甲。
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    await addClipViaUi(page, 0.2, 0.6, '乙：前段');
    await addClipViaUi(page, 0.8, 1.3, '丙：中段');

    const items = page.locator('[data-testid="clip-item"]');
    const itemJia = items.nth(0);
    const itemYi = items.nth(1);
    const itemBing = items.nth(2);
    const bing = readBounds(await itemBing.locator('[data-testid="clip-bounds"]').textContent());
    const jia = readBounds(await itemJia.locator('[data-testid="clip-bounds"]').textContent());

    await itemBing.locator('[data-testid="clip-select"]').check();
    await expect(itemBing).toHaveClass(/selected/);

    // 记录每次真正进入播放（play 事件）时的媒体位置，证明只播丙与甲、各播一次
    await audio.evaluate((el: HTMLAudioElement) => {
      const w = window as unknown as { __playTimes: number[] };
      w.__playTimes = [];
      el.addEventListener('play', () => w.__playTimes.push(el.currentTime * 1000));
    });

    await page.locator('[data-testid="sequential-audition"]').click();
    const badge = page.locator('[data-testid="sequential-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('丙：中段');
    await expect(badge).toContainText('1/2');
    // 从选中片段的精确起点开始：点击后播放可能已推进数毫秒，位置应在起点与终点之间
    const atStart = await positionMs(page);
    expect(atStart).toBeGreaterThanOrEqual(bing.startMs - 1);
    expect(atStart).toBeLessThan(bing.endMs);
    expect(await isPaused(page)).toBe(false);

    // 丙到终点：暂停并精确复位到丙起点（切换停留期间），选择仍在丙
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - bing.startMs)).toBeLessThanOrEqual(1);
    await expect(itemBing).toHaveClass(/selected/);
    await expect(itemYi).not.toHaveClass(/selected/);
    await expect(badge).toContainText('切换下一片段');

    // 自动选中并播放下一条甲：选择推进；播放后位置持续前移，只断言仍在甲范围内，
    // “从甲精确起点开始”由下面的 play 事件位置记录证明。
    await expect(itemJia).toHaveClass(/selected/);
    await expect(badge).toContainText('2/2');
    await expect.poll(() => isPaused(page), { timeout: 2000, intervals: [16] }).toBe(false);
    const posJia = await positionMs(page);
    expect(posJia).toBeGreaterThanOrEqual(jia.startMs - 1);
    expect(posJia).toBeLessThan(jia.endMs);
    // 乙始终不在选择中——排序中位于起点片段之前的记录不参与本次审听
    await expect(itemYi).not.toHaveClass(/selected/);

    // 末条甲结束：停在甲的精确起点并退出顺序审听
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - jia.startMs)).toBeLessThanOrEqual(1);
    await expect(badge).toHaveCount(0);
    await expect(itemJia).toHaveClass(/selected/);
    await expect(itemBing).not.toHaveClass(/selected/);
    await expect(page.locator('[data-testid="sequential-note"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sequential-audition"]')).toBeEnabled();
    // 已保存记录及顺序不变
    await expect(items).toHaveCount(3);

    // 只有丙起点与甲起点各触发一次播放（play 事件在定位之后、推进之前记录，须为精确起点）；
    // 排序之前的乙从未播放。
    const playTimes = await page.evaluate(
      () => (window as unknown as { __playTimes: number[] }).__playTimes,
    );
    expect(playTimes).toHaveLength(2);
    expect(Math.abs(playTimes[0] - bing.startMs)).toBeLessThanOrEqual(1);
    expect(Math.abs(playTimes[1] - jia.startMs)).toBeLessThanOrEqual(1);
  });

  test('播放当前片段中途点既有“停止试听”：暂停并精确回到当前片段起点，选择保留，可重新开始', async ({
    page,
  }) => {
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    await addClipViaUi(page, 0.2, 0.9, '乙：前段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemYi = items.nth(1);
    const yi = readBounds(await itemYi.locator('[data-testid="clip-bounds"]').textContent());

    // 从排序首条乙开始（队列 乙 → 甲）
    await itemYi.locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();
    await expect(page.locator('[data-testid="sequential-badge"]')).toBeVisible();

    // 等进入乙的播放中段再停止
    await expect
      .poll(() => currentMs(page), { timeout: 2000, intervals: [16] })
      .toBeGreaterThanOrEqual(yi.startMs + 150);
    await itemYi.locator('[data-testid="stop-audition"]').click();

    expect(await isPaused(page)).toBe(true);
    expect(Math.abs((await positionMs(page)) - yi.startMs)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
    await expect(itemYi).toHaveClass(/selected/);
    await expect(page.locator('[data-testid="sequential-audition"]')).toBeEnabled();
    // 游标停在乙起点，不再自动推进到甲
    await page.waitForTimeout(700);
    expect(Math.abs((await positionMs(page)) - yi.startMs)).toBeLessThanOrEqual(1);
    expect(await isPaused(page)).toBe(true);
    await expect(items.nth(0)).not.toHaveClass(/selected/);
  });

  test('切换下一片段停留期间点“停止试听”：停在刚播完片段起点并退出', async ({ page }) => {
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    await addClipViaUi(page, 0.2, 0.9, '乙：前段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemYi = items.nth(1);
    const yi = readBounds(await itemYi.locator('[data-testid="clip-bounds"]').textContent());

    await itemYi.locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();

    // 乙播完进入切换停留：暂停在乙起点、徽标仍可见
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    await expect(page.locator('[data-testid="sequential-badge"]')).toContainText('切换下一片段');
    expect(Math.abs((await positionMs(page)) - yi.startMs)).toBeLessThanOrEqual(1);

    await itemYi.locator('[data-testid="stop-audition"]').click();
    expect(await isPaused(page)).toBe(true);
    expect(Math.abs((await positionMs(page)) - yi.startMs)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
    await expect(itemYi).toHaveClass(/selected/);
    await page.waitForTimeout(700);
    expect(await isPaused(page)).toBe(true);
  });

  test('开始播放被媒体拒绝：终止并在清单旁说明失败片段，记录不变，恢复后可从当前选择重试成功', async ({
    page,
  }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    await addClipViaUi(page, 0.2, 0.6, '乙：前段');
    await addClipViaUi(page, 0.8, 1.3, '丙：中段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemBing = items.nth(2);
    const bing = readBounds(await itemBing.locator('[data-testid="clip-bounds"]').textContent());
    const jia = readBounds(await items.nth(0).locator('[data-testid="clip-bounds"]').textContent());
    await itemBing.locator('[data-testid="clip-select"]').check();

    // 让媒体拒绝播放
    await audio.evaluate((el: HTMLAudioElement) => {
      el.play = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    });
    await page.locator('[data-testid="sequential-audition"]').click();
    const note = page.locator('[data-testid="sequential-note"]');
    await expect(note).toBeVisible();
    await expect(note).toContainText('丙：中段');
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sequential-audition"]')).toBeEnabled();
    await expect(items).toHaveCount(3);
    await expect(itemBing).toHaveClass(/selected/);

    // 恢复媒体播放能力后从当前选择重试：正常推进到甲并收束
    await audio.evaluate((el: HTMLAudioElement) => {
      delete (el as Partial<HTMLAudioElement>).play;
    });
    await page.locator('[data-testid="sequential-audition"]').click();
    await expect(page.locator('[data-testid="sequential-badge"]')).toBeVisible();
    const retryPos = await positionMs(page);
    expect(retryPos).toBeGreaterThanOrEqual(bing.startMs - 1);
    expect(retryPos).toBeLessThan(bing.endMs);
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    await expect(items.nth(0)).toHaveClass(/selected/);
    await expect.poll(() => isPaused(page), { timeout: 2000, intervals: [16] }).toBe(false);
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - jia.startMs)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
  });
});

test.describe('顺序审听回归：单条循环试听、校准与导出不受影响', () => {
  test('单条循环试听仍按原行为循环、复位、停止回起点', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    await addClipViaUi(page, 0.5, 1.2, '回归：循环片段');
    const item = page.locator('[data-testid="clip-item"]').first();
    const bounds = readBounds(await item.locator('[data-testid="clip-bounds"]').textContent());

    await audio.evaluate((el: HTMLAudioElement) => {
      (window as unknown as { __plays: number }).__plays = 0;
      el.addEventListener('play', () => {
        (window as unknown as { __plays: number }).__plays += 1;
      });
    });

    await item.locator('[data-testid="audition-clip"]').click();
    await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
    await expect
      .poll(() => currentMs(page), { timeout: 2000, intervals: [16] })
      .toBeGreaterThanOrEqual(bounds.startMs);

    // 第一次到终点复位
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - bounds.startMs)).toBeLessThanOrEqual(1);
    // 自动再循环一次
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __plays: number }).__plays),
        { timeout: 3000, intervals: [30] },
      )
      .toBe(2);
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - bounds.startMs)).toBeLessThanOrEqual(1);

    // 顺序审听徽标不应出现；停止后仍精确回起点
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
    await item.locator('[data-testid="stop-audition"]').click();
    expect(await isPaused(page)).toBe(true);
    expect(Math.abs((await positionMs(page)) - bounds.startMs)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="audition-badge"]')).toHaveCount(0);
  });

  test('校准保存后仍选中并按新范围循环试听；导出排序与内容不变', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    // 创建顺序故意与导出顺序不同
    await addClipViaUi(page, 2.0, 2.5, '后创建的片段'); // createdAt 0
    await addClipViaUi(page, 0.2, 0.8, '先导出的片段'); // createdAt 1
    await addClipViaUi(page, 0.2, 0.5, '同起点更早结束'); // createdAt 2

    // 校准清单第 3 条到 50–250
    const items = page.locator('[data-testid="clip-item"]');
    await items.nth(2).locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="edit-selected-clip"]').click();
    await page.locator('[data-testid="edit-start-input"]').fill('50');
    await page.locator('[data-testid="edit-end-input"]').fill('250');
    await page.locator('[data-testid="edit-label-input"]').fill('校准后排最前');
    await page.locator('[data-testid="save-clip-edit"]').click();
    await expect(page.locator('[data-testid="clip-editor"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
    // 保存即按新范围试听：到 250 复位到 50
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - 50)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
    await page
      .locator('[data-testid="clip-item"]')
      .nth(2)
      .locator('[data-testid="stop-audition"]')
      .click();

    // 导出：排序规则未变，校准记录排最前，createdAt 仍为 2
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="export-json"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('sample.clips.json');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(payload.durationMs).toBe(3250);
    expect(payload.clips).toHaveLength(3);
    expect(payload.clips.map((c: { label: string }) => c.label)).toEqual([
      '校准后排最前',
      '先导出的片段',
      '后创建的片段',
    ]);
    expect(payload.clips[0]).toMatchObject({
      index: 0,
      startMs: 50,
      endMs: 250,
      durationMs: 200,
      createdAt: 2,
    });
    void audio;
  });
});
