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

// 以原生 setter 写入并派发 input/change，模拟用户拖动共享游标（React 受控 range）。
async function dragScrubberTo(page: Page, ms: number) {
  await page
    .locator('[data-testid="scrubber"]')
    .evaluate((el: HTMLInputElement, value: number) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, ms);
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

test.describe('顺序审听会话与共享播放器/打点的一致性', () => {
  test('播放当前片段时点共享“暂停”：会话同步退出审听，不再推进', async ({ page }) => {
    await addClipViaUi(page, 0.2, 1.5, '乙：前段');
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemYi = items.nth(0);
    const itemJia = items.nth(1);
    const yi = readBounds(await itemYi.locator('[data-testid="clip-bounds"]').textContent());

    await itemYi.locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();
    const badge = page.locator('[data-testid="sequential-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('1/2');

    // 等进入乙的播放中段，再点共享播放器的“暂停”
    await expect
      .poll(() => currentMs(page), { timeout: 2000, intervals: [16] })
      .toBeGreaterThanOrEqual(yi.startMs + 150);
    await page.locator('[data-testid="play-button"]').click();

    // 音频停止，会话同步退出：徽标消失、入口恢复可用、选择保留在乙
    expect(await isPaused(page)).toBe(true);
    await expect(page.locator('[data-testid="play-button"]')).toHaveText('播放');
    await expect(badge).toHaveCount(0);
    await expect(page.locator('[data-testid="sequential-audition"]')).toBeEnabled();
    await expect(itemYi).toHaveClass(/selected/);
    // 游标停在用户暂停处，不被拉回片段起点
    expect(await positionMs(page)).toBeGreaterThan(yi.startMs + 50);

    // 会话已退出：不再自动推进到甲，也不再发声
    await page.waitForTimeout(700);
    expect(await isPaused(page)).toBe(true);
    await expect(badge).toHaveCount(0);
    await expect(itemJia).not.toHaveClass(/selected/);
    await expect(itemYi).toHaveClass(/selected/);
  });

  test('播放当前记录时拖动共享游标越过终点：不提前结算，依照既定边界完成审听', async ({
    page,
  }) => {
    await addClipViaUi(page, 0.2, 0.9, '乙：前段');
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemYi = items.nth(0);
    const itemJia = items.nth(1);
    const yi = readBounds(await itemYi.locator('[data-testid="clip-bounds"]').textContent());
    const jia = readBounds(await itemJia.locator('[data-testid="clip-bounds"]').textContent());

    await itemYi.locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();
    const badge = page.locator('[data-testid="sequential-badge"]');
    await expect(badge).toBeVisible();
    await expect
      .poll(() => currentMs(page), { timeout: 2000, intervals: [16] })
      .toBeGreaterThanOrEqual(yi.startMs + 100);

    // 拖动共享游标越过乙的终点：不得提前结算并推进
    await dragScrubberTo(page, yi.endMs + 600);
    // 会话仍在播放当前片段（1/2），选择仍在乙，媒体未暂停，游标回到乙范围内
    await expect(badge).toContainText('播放当前片段');
    await expect(badge).toContainText('1/2');
    await expect(itemYi).toHaveClass(/selected/);
    expect(await isPaused(page)).toBe(false);
    expect(await positionMs(page)).toBeLessThan(yi.endMs);

    // 乙依照既定边界播到终点后才推进：先暂停复位（切换停留），再选中并播放甲
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - yi.startMs)).toBeLessThanOrEqual(1);
    await expect(badge).toContainText('切换下一片段');
    await expect(itemJia).toHaveClass(/selected/, { timeout: 2000 });
    await expect(badge).toContainText('2/2');
    await expect.poll(() => isPaused(page), { timeout: 2000, intervals: [16] }).toBe(false);

    // 末条甲结束：停在甲起点并退出
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - jia.startMs)).toBeLessThanOrEqual(1);
    await expect(badge).toHaveCount(0);
  });

  test('切换停留期间点共享“播放”：只播放即将推进的下一条', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    await addClipViaUi(page, 0.2, 0.6, '乙：前段');
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemYi = items.nth(0);
    const itemJia = items.nth(1);
    const yi = readBounds(await itemYi.locator('[data-testid="clip-bounds"]').textContent());
    const jia = readBounds(await itemJia.locator('[data-testid="clip-bounds"]').textContent());

    // 记录每次真正进入播放（play 事件）时的媒体位置
    await audio.evaluate((el: HTMLAudioElement) => {
      const w = window as unknown as { __playTimes: number[] };
      w.__playTimes = [];
      el.addEventListener('play', () => w.__playTimes.push(el.currentTime * 1000));
    });

    await itemYi.locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();
    const badge = page.locator('[data-testid="sequential-badge"]');

    // 乙播完进入切换停留：暂停在乙起点
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    await expect(badge).toContainText('切换下一片段');
    expect(Math.abs((await positionMs(page)) - yi.startMs)).toBeLessThanOrEqual(1);

    // 停留期间点共享“播放”：立即推进到甲，刚结束的乙不会再次发声
    await page.locator('[data-testid="play-button"]').click();
    await expect(itemJia).toHaveClass(/selected/);
    await expect(badge).toContainText('2/2');
    await expect(badge).toContainText('播放当前片段');
    expect(await isPaused(page)).toBe(false);
    const posJia = await positionMs(page);
    expect(posJia).toBeGreaterThanOrEqual(jia.startMs - 1);
    expect(posJia).toBeLessThan(jia.endMs);

    // 只有乙起点与甲起点各触发一次播放——乙没有从起点再次发声
    const playTimes = await page.evaluate(
      () => (window as unknown as { __playTimes: number[] }).__playTimes,
    );
    expect(playTimes).toHaveLength(2);
    expect(Math.abs(playTimes[0] - yi.startMs)).toBeLessThanOrEqual(1);
    expect(Math.abs(playTimes[1] - jia.startMs)).toBeLessThanOrEqual(1);

    // 末条甲结束：停在甲起点并退出
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    expect(Math.abs((await positionMs(page)) - jia.startMs)).toBeLessThanOrEqual(1);
    await expect(badge).toHaveCount(0);
  });

  test('顺序审听中捕获并新增片段：选择始终对应播放目标', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    await addClipViaUi(page, 0.2, 1.5, '乙：前段');
    await addClipViaUi(page, 2.0, 2.5, '甲：后段');
    const items = page.locator('[data-testid="clip-item"]');
    const itemYi = items.nth(0);
    const itemJia = items.nth(1);

    // 审听前先备好一组待加入的边界与标签
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 0.4;
    });
    await page.waitForTimeout(120);
    await page.locator('[data-testid="capture-start"]').click();
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 0.6;
    });
    await page.waitForTimeout(120);
    await page.locator('[data-testid="capture-end"]').click();
    await page.locator('[data-testid="label-input"]').fill('丙：审听中新增');

    await itemYi.locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();
    const badge = page.locator('[data-testid="sequential-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('播放当前片段');

    // 审听乙的过程中加入新片段：记录入清单，但选择不跳走，音频继续播放乙
    await page.locator('[data-testid="add-clip"]').click();
    await expect(items).toHaveCount(3);
    const itemBing = items.nth(2);
    await expect(itemYi).toHaveClass(/selected/);
    await expect(itemBing).not.toHaveClass(/selected/);
    await expect(badge).toContainText('乙：前段');
    await expect(badge).toContainText('1/2');
    expect(await isPaused(page)).toBe(false);

    // 推进到甲：选择随播放目标前移，仍不落在新增记录上
    await expect(itemJia).toHaveClass(/selected/, { timeout: 4000 });
    await expect(badge).toContainText('2/2');
    await expect(itemBing).not.toHaveClass(/selected/);

    // 末条结束退出：选择停在甲，新增记录始终未成为播放目标的选择
    await expect.poll(() => isPaused(page), { timeout: 3000, intervals: [16] }).toBe(true);
    await expect(badge).toHaveCount(0);
    await expect(itemJia).toHaveClass(/selected/);
    await expect(itemBing).not.toHaveClass(/selected/);
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
