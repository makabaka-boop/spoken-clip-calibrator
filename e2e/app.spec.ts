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

async function currentMs(page: Page): Promise<number> {
  const text = await page.locator('[data-testid="current-ms"]').textContent();
  return Number((text ?? '').replace(/[^\d-]/g, ''));
}

async function waitCurrentMs(page: Page, target: number, tolerance = 30) {
  await expect
    .poll(async () => currentMs(page), { timeout: 5000, intervals: [16] })
    .toBeGreaterThanOrEqual(target - tolerance);
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

test.describe('加载音频', () => {
  test('不可解码文件就地报错且不改变清单', async ({ page }) => {
    await page.goto('/');
    await loadFile(page, 'not-audio.txt');

    await expect(page.locator('[data-testid="error"]')).toBeVisible();
    await expect(page.locator('[data-testid="error"]')).toContainText(/无法解码/);
    await expect(page.locator('[data-testid="audio-meta"]')).toHaveCount(0);
    // 清单仍是初始空态
    await expect(page.locator('[data-testid="empty-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="duration-ms"]')).toHaveCount(0);
  });

  test('载入仓库内短音频，时长为 3250 ms', async ({ page }) => {
    await page.goto('/');
    await loadFile(page, 'sample.wav');
    await expect(page.locator('[data-testid="audio-meta"]')).toBeVisible();
    await expect(page.locator('[data-testid="duration-ms"]')).toHaveText(/3250\s*ms/);
    await expect(page.locator('[data-testid="error"]')).toHaveCount(0);
  });
});

test.describe('打点、边界与试听', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadFile(page, 'sample.wav');
    await expect(page.locator('[data-testid="duration-ms"]')).toBeVisible();
  });

  test('走通打点 → 循环试听（到终点暂停并精确回到起点）→ 再循环 → 停止仍回起点', async ({
    page,
  }) => {
    const audio = page.locator('[data-testid="audio-element"]');

    // 第一个片段：起点 500ms 附近、终点 1400ms 附近（四舍五入的整数毫秒）
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 0.5;
    });
    await waitCurrentMs(page, 470, 40);
    await page.locator('[data-testid="capture-start"]').click();
    const startTextA = (
      await page.locator('[data-testid="pending-start"]').textContent()
    ) ?? '';
    const startA = Number(startTextA.match(/^(\d+)/)?.[1] ?? 'NaN');
    expect(startA).toBeGreaterThanOrEqual(480);
    expect(startA).toBeLessThanOrEqual(520);

    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 1.4;
    });
    await waitCurrentMs(page, 1370, 40);
    await page.locator('[data-testid="capture-end"]').click();
    const endTextA = (await page.locator('[data-testid="pending-end"]').textContent()) ?? '';
    const endA = Number(endTextA.match(/^(\d+)/)?.[1] ?? 'NaN');
    expect(endA).toBeGreaterThanOrEqual(1380);
    expect(endA).toBeLessThanOrEqual(1420);

    await page.locator('[data-testid="label-input"]').fill('片段甲：440 赫兹陈述');
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="error"]')).toHaveCount(0);

    // 第二个片段（创建得更早的起点，用于验证导出重排）
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 0.1;
    });
    await waitCurrentMs(page, 70, 40);
    await page.locator('[data-testid="capture-start"]').click();
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 0.3;
    });
    await waitCurrentMs(page, 270, 40);
    await page.locator('[data-testid="capture-end"]').click();
    await page.locator('[data-testid="label-input"]').fill('片段乙：开头补充');
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(2);

    // 记录 audio 元素的播放事件次数，用于证明发生了两次循环
    await audio.evaluate((el: HTMLAudioElement) => {
      (window as unknown as { __plays: number }).__plays = 0;
      el.addEventListener('play', () => {
        (window as unknown as { __plays: number }).__plays += 1;
      });
    });

    // 循环试听第一个片段
    const firstItem = page.locator('[data-testid="clip-item"]').first();
    await firstItem.locator('[data-testid="audition-clip"]').click();
    await expect(page.locator('[data-testid="audition-badge"]')).toBeVisible();

    // 必须从记录起点开始
    await expect
      .poll(() => currentMs(page), { timeout: 3000, intervals: [16] })
      .toBeGreaterThanOrEqual(startA);

    // 首次达到/越过终点 → 暂停且游标精确回到起点（容差 1ms）
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), {
        timeout: 5000,
        intervals: [16],
      })
      .toBe(true);
    const backAtStart = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    expect(Math.abs(backAtStart - startA)).toBeLessThanOrEqual(1);

    // 再循环一次：play 事件计数从 1（首次试听）增至 2
    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __plays: number }).__plays),
        { timeout: 3000, intervals: [30] },
      )
      .toBe(2);
    // 第二次越过终点后同样回到精确起点
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.paused), {
        timeout: 5000,
        intervals: [16],
      })
      .toBe(true);
    const backAgain = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    expect(Math.abs(backAgain - startA)).toBeLessThanOrEqual(1);

    // 停止试听：暂停并保持在精确起点，验收者肉眼可见游标复位
    await firstItem.locator('[data-testid="stop-audition"]').click();
    const afterStop = await audio.evaluate((el: HTMLAudioElement) => el.currentTime * 1000);
    const stopped = await audio.evaluate((el: HTMLAudioElement) => el.paused);
    expect(stopped).toBe(true);
    expect(Math.abs(afterStop - startA)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="audition-badge"]')).toHaveCount(0);

    // 选择：单选高亮
    const secondItem = page.locator('[data-testid="clip-item"]').nth(1);
    await secondItem.locator('[data-testid="clip-select"]').check();
    await expect(firstItem).not.toHaveClass(/selected/);
    await expect(secondItem).toHaveClass(/selected/);

    // 删除第二个片段后清单减一，仍能看到第一个
    await secondItem.locator('[data-testid="delete-clip"]').click();
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
  });

  test('空标签、相等边界、反向边界就地报错且不改变清单', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');

    async function captureAt(startSec: number, endSec: number) {
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
    }

    // 空标签
    await captureAt(0.2, 0.8);
    await page.locator('[data-testid="label-input"]').fill('   ');
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="error"]')).toContainText('标签不能为空');
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(0);

    // 相等边界
    await page.locator('[data-testid="label-input"]').fill('非法片段');
    await captureAt(1.0, 1.0);
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="error"]')).toContainText('相等');
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(0);

    // 反向边界（起点晚于终点）
    await captureAt(2.0, 1.0);
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="error"]')).toContainText('反向');
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(0);

    // 修正后可以正常加入，说明错误没有污染状态
    await captureAt(1.0, 2.0);
    await page.locator('[data-testid="label-input"]').fill('合法片段');
    await page.locator('[data-testid="add-clip"]').click();
    await expect(page.locator('[data-testid="clip-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="error"]')).toHaveCount(0);
  });

  test('播放中 currentTime 毫秒读数随真实播放推进，不吸附整秒', async ({ page }) => {
    const audio = page.locator('[data-testid="audio-element"]');
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 1.0;
    });
    await page.locator('[data-testid="play-button"]').click();
    await expect(page.locator('[data-testid="play-button"]')).toHaveText('暂停');
    // 连续两次读数应严格推进，且出现非整秒毫秒值
    const readings: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      readings.push(await currentMs(page));
      await page.waitForTimeout(60);
    }
    const advancing = readings.slice(1).some((v, i) => v > readings[i]);
    expect(advancing).toBe(true);
    expect(readings.some((v) => v % 1000 !== 0)).toBe(true);
    await page.locator('[data-testid="play-button"]').click();
  });
});

test.describe('导出', () => {
  test('导出 JSON：文件名/时长正确、按起点终点创建序排序、可复算边界', async ({ page }) => {
    await page.goto('/');
    await loadFile(page, 'sample.wav');
    const audio = page.locator('[data-testid="audio-element"]');

    async function addClip(startSec: number, endSec: number, label: string) {
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

    // 创建顺序故意与导出顺序不同
    await addClip(2.0, 2.5, '后创建的片段'); // createdAt 0
    await addClip(0.2, 0.8, '先导出的片段'); // createdAt 1
    await addClip(0.2, 0.5, '同起点更早结束'); // createdAt 2

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="export-json"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('sample.clips.json');

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    expect(payload.audioFileName).toBe('sample.wav');
    expect(payload.durationMs).toBe(3250);
    expect(payload.clips).toHaveLength(3);

    const labels = payload.clips.map((c: { label: string }) => c.label);
    expect(labels).toEqual(['同起点更早结束', '先导出的片段', '后创建的片段']);

    // 每个片段都可从下载内容复算
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

    // 同起点 (0.2s 附近) 按终点升序
    expect(payload.clips[0].endMs).toBeLessThan(payload.clips[1].endMs);
    expect(payload.clips[0].createdAt).toBe(2);
    expect(payload.clips[1].createdAt).toBe(1);
    expect(payload.clips[2].createdAt).toBe(0);
  });
});
