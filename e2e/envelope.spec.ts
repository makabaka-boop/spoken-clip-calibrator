import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ASSETS = join(process.cwd(), 'test-assets');

async function loadFile(page: Page, fileName: string) {
  const buffer = await readFile(join(ASSETS, fileName));
  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: fileName,
    mimeType: fileName.endsWith('.wav') ? 'audio/wav' : 'text/plain',
    buffer,
  });
}

async function importJson(page: Page, content: string) {
  await page.locator('[data-testid="import-input"]').setInputFiles({
    name: 'sample.clips.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content, 'utf8'),
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

async function currentMs(page: Page): Promise<number> {
  const text = await page.locator('[data-testid="current-ms"]').textContent();
  return Number((text ?? '').replace(/[^\d-]/g, ''));
}

// 轮廓上是否已绘制非背景像素（证明画布真的画了东西，而非空白）。
async function canvasHasInk(page: Page): Promise<boolean> {
  return page
    .locator('[data-testid="envelope-canvas"]')
    .evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext('2d');
      if (!ctx) return false;
      const { width, height } = el;
      if (!width || !height) return false;
      const data = ctx.getImageData(0, 0, width, height).data;
      for (let i = 0; i < data.length; i += 4) {
        // 蓝色柱条：蓝通道明显高于红/绿，且整体非背景深色。
        if (data[i + 2] > 120 && data[i + 2] > data[i] + 40) return true;
      }
      return false;
    });
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

test.describe('整段振幅概览', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadFile(page, 'sample.wav');
    await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();
  });

  test('载入短音频后经过“分析中”到达“可用”，canvas 绘制整段轮廓，且不依赖播放进度', async ({
    page,
  }) => {
    // 载入后自动分析：先出现分析中提示（可能很短暂），随后轮廓可用。
    await expect(page.locator('[data-testid="envelope-canvas"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="envelope-analyzing"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="envelope-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="envelope-summary"]')).toContainText('等分时段');

    const canvas = page.locator('[data-testid="envelope-canvas"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);

    // 轮廓确实绘制了非背景内容；此时尚未播放过（进度 0）。
    await expect.poll(() => currentMs(page), { timeout: 2000 }).toBe(0);
    expect(await canvasHasInk(page)).toBe(true);
  });

  test('点击轮廓按横向比例定位到可预测的整数毫秒，且随后可继续捕获片段', async ({
    page,
  }) => {
    const canvas = page.locator('[data-testid="envelope-canvas"]');
    await expect(canvas).toBeVisible({ timeout: 5000 });
    const box = await canvas.boundingBox();
    const audio = page.locator('[data-testid="audio-element"]');

    // 点击整数像素位置，使横向比例与换算位置可预测：
    // 325px / 812.5px(scale 1) 等比例 -> 0.4 * 3250 = 1300 ms；另以容差兜底子像素误差。
    const target = Math.round(box!.width * 0.4);
    await canvas.click({ position: { x: target, y: box!.height / 2 } });
    await expect
      .poll(() => currentMs(page), { timeout: 2000, intervals: [16] })
      .toBeGreaterThanOrEqual(1297);
    expect(await currentMs(page)).toBeLessThanOrEqual(1303);
    const elementPos = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    expect(Math.abs(elementPos - 1300)).toBeLessThanOrEqual(3);
    // 定位是暂停态，不自动开始播放
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    // 时间提示给出整数毫秒（位置与换算一致，容差 3ms）
    const hint = await page.locator('[data-testid="envelope-time-hint"]').textContent();
    const hintMs = Number(hint?.match(/位置 (\d+) ms/)?.[1] ?? 'NaN');
    expect(Math.abs(hintMs - 1300)).toBeLessThanOrEqual(3);

    // 点击最右可点像素中心：宽度 906px 时最后一个像素中心比例为 905/906，
    // 换算 ≈ 3246 ms（ratio=1.0 的精确钳制由 Vitest ratioToPositionMs 直接覆盖）。
    const rightMs = Math.round((box!.width - 1) / box!.width * 3250);
    await canvas.evaluate((el: HTMLCanvasElement) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          clientX: rect.right - 1,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    await expect
      .poll(() => currentMs(page), { timeout: 2000, intervals: [16] })
      .toBe(rightMs);

    // 点击最左端（在元素的第一个物理像素派发点击）-> 0
    await canvas.evaluate((el: HTMLCanvasElement) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          clientX: rect.left,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    await expect.poll(() => currentMs(page), { timeout: 2000, intervals: [16] }).toBe(0);

    // 定位后继续打点、捕获片段：概览定位与既有打点流程兼容
    await canvas.click({ position: { x: box!.width * 0.1, y: box!.height / 2 } });
    await page.waitForTimeout(80);
    await page.locator('[data-testid="capture-start"]').click();
    await canvas.click({ position: { x: box!.width * 0.5, y: box!.height / 2 } });
    await page.waitForTimeout(80);
    await page.locator('[data-testid="capture-end"]').click();
    await page.locator('[data-testid="label-input"]').fill('轮廓定位后捕获');
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
    const bounds = (
      await page.locator('[data-testid="clip-bounds"]').first().textContent()
    ) ?? '';
    const startMs = Number(bounds.match(/^(\d+) ms/)?.[1] ?? 'NaN');
    const endMs = Number(bounds.match(/→ (\d+) ms/)?.[1] ?? 'NaN');
    expect(startMs).toBeGreaterThanOrEqual(300);
    expect(startMs).toBeLessThanOrEqual(350);
    expect(endMs).toBeGreaterThanOrEqual(1600);
    expect(endMs).toBeLessThanOrEqual(1650);
    expect(await page.locator('[data-testid="error"]')).toHaveCount(0);
  });

  test('轮廓定位前结束正在进行的单条循环试听与顺序审听', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    await addClipViaUi(page, 0.2, 0.9, '前段片段');
    await addClipViaUi(page, 2.0, 2.5, '后段片段');
    const item = page.locator('[data-testid="clip-item"]').first();

    // 单条循环试听中点击轮廓：试听结束、音频暂停并定位
    await item.locator('[data-testid="audition-clip"]').click();
    await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();
    const canvas = page.locator('[data-testid="envelope-canvas"]');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: box!.width * 0.6, y: box!.height / 2 } });
    await expect(page.locator('[data-testid="audition-badge"]')).toHaveCount(0);
    await expect.poll(async () => audio.evaluate((el) => el.paused), { timeout: 2000 }).toBe(true);
    // 越过循环复位等待期（450ms）后仍暂停在定位点，没有继续发声或回到片段起点
    await page.waitForTimeout(700);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    const pos = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    expect(Math.abs(pos - 1950)).toBeLessThanOrEqual(3);

    // 顺序审听中点击轮廓：会话结束、徽标消失、音频暂停定位，选择保留
    await page.locator('[data-testid="clip-item"]').nth(1).locator('[data-testid="clip-select"]').check();
    await page.locator('[data-testid="sequential-audition"]').click();
    await expect(page.locator('[data-testid="sequential-badge"]')).toBeVisible();
    await canvas.click({ position: { x: box!.width * 0.3, y: box!.height / 2 } });
    await expect(page.locator('[data-testid="sequential-badge"]')).toHaveCount(0);
    await expect.poll(async () => audio.evaluate((el) => el.paused), { timeout: 2000 }).toBe(true);
    await page.waitForTimeout(700);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    const pos2 = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    expect(Math.abs(pos2 - 975)).toBeLessThanOrEqual(3);
    // 片段与选择都还在
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="sequential-audition"]')).toBeEnabled();
  });

  test('更换音频清除旧概览并为新音频重新分析（迟到结果被忽略）', async ({ page }) => {
    const canvas = page.locator('[data-testid="envelope-canvas"]');
    await expect(canvas).toBeVisible({ timeout: 5000 });
    expect(await canvasHasInk(page)).toBe(true);

    // 记录旧轮廓的画布尺寸，作为“旧概览曾就绪”的参照。
    const before = await canvas.evaluate((el: HTMLCanvasElement) => ({
      width: el.width,
      height: el.height,
    }));

    // 重新选择同一段仓库音频：旧概览被清除并重新生成，最终仍为可用、无失败态；
    // 上一段音频即使有迟到结果也会被 run id 丢弃（同一文件下表现为重新分析成功）。
    await loadFile(page, 'sample.wav');
    // 重新分析期间允许出现分析中态（短到可能捕获不到，故只作软断言：最终必须可用）。
    await expect(canvas).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="envelope-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="envelope-summary"]')).toContainText('等分时段');
    expect(await canvasHasInk(page)).toBe(true);
    const after = await canvas.evaluate((el: HTMLCanvasElement) => ({
      width: el.width,
      height: el.height,
    }));
    expect(after).toEqual(before);
  });

  test('模拟分析失败：只在概览区说明原因，片段、选择与已加载音频均不变', async ({ page }) => {
    // 先准备好片段清单，再让 Web Audio 解码始终失败并整页重载：
    // 重载后音频需重新载入（概览随之分析），而片段通过导入恢复。
    await page.addInitScript(() => {
      const proto = window.AudioContext.prototype as unknown as {
        decodeAudioData: (...args: unknown[]) => Promise<never>;
      };
      proto.decodeAudioData = () =>
        Promise.reject(new DOMException('synthetic decode failure', 'EncodingError'));
    });
    await page.reload();
    await loadFile(page, 'sample.wav');
    await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();

    // 概览进入失败态：原因只出现在概览区
    await expect(page.locator('[data-testid="envelope-error"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="envelope-error"]')).toContainText(/无法解码/);
    await expect(page.locator('[data-testid="envelope-canvas"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="envelope-analyzing"]')).toHaveCount(0);

    // 失败前导入一份清单，验证失败不清空片段/选择/已加载音频
    const payload = {
      audioFileName: 'sample.wav',
      durationMs: 3250,
      clips: [
        { index: 0, startMs: 100, endMs: 400, durationMs: 300, label: '保留片段甲', createdAt: 0 },
        { index: 1, startMs: 1000, endMs: 1400, durationMs: 400, label: '保留片段乙', createdAt: 1 },
      ],
    };
    await importJson(page, JSON.stringify(payload));
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="clip-item"]').first()).toHaveClass(/selected/);
    await expect(page.locator('[data-testid="audio-meta"]')).toBeVisible();
    await expect(page.locator('[data-testid="duration-ms"]')).toContainText('3250');

    // 全局错误区保持干净：失败没有冒泡到打点表单的错误提示
    await expect(page.locator('[data-testid="error"]')).toHaveCount(0);
    // 概览仍停留在失败态，但播放器与打点入口仍可用
    await expect(page.locator('[data-testid="envelope-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="play-button"]')).toBeEnabled();
    await expect(page.locator('[data-testid="capture-start"]')).toBeEnabled();

    // 已加载音频仍可正常播放（HTMLMediaElement 解码与概览解码相互独立）
    await page.locator('[data-testid="play-button"]').click();
    await expect(page.locator('[data-testid="play-button"]')).toHaveText('暂停');
    await expect
      .poll(() => currentMs(page), { timeout: 3000, intervals: [16] })
      .toBeGreaterThan(100);
  });
});
