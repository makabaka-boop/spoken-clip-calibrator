import { toMillis } from './time';

/**
 * 整段音频的振幅概览（与画布、播放进度完全无关的纯数据）：
 * - durationMs：由解码采样数 / 采样率得到，与打点同一套四舍五入取整规则；
 * - bucketCount：等分时段（桶）的数量；
 * - peaks：每个时段内各声道绝对采样的最大值，再按整段全局最大峰值归一化到 0–1。
 */
export interface AudioEnvelope {
  durationMs: number;
  bucketCount: number;
  peaks: readonly number[];
}

export interface AudioEnvelopeResult {
  ok: boolean;
  envelope?: AudioEnvelope;
  error?: string;
}

/** 概览在界面上的三种状态：分析中 / 可用 / 失败（失败只在概览区说明原因）。 */
export type AudioEnvelopeState = 'analyzing' | 'available' | 'failed';

/**
 * 把解码后的多声道采样按时长等分为 bucketCount 个桶，逐采样取各声道之间的
 * 绝对最大值（跨声道绝对峰值）记入所属桶。纯函数：只依赖采样数据与桶数，
 * 与画布像素尺寸、播放进度无关。
 *
 * 桶归属按 floor(i * bucketCount / length) 计算，末桶用 min 兜底，
 * 保证非整除时长下每个采样都恰好落入一个桶且桶数精确等于 bucketCount。
 */
export function collectBucketPeaks(
  channelData: readonly Float32Array[],
  bucketCount: number,
): number[] {
  const peaks = new Array<number>(bucketCount).fill(0);
  if (channelData.length === 0) return peaks;
  const length = channelData[0].length;
  if (length === 0) return peaks;
  for (let i = 0; i < length; i += 1) {
    let samplePeak = 0;
    for (let channel = 0; channel < channelData.length; channel += 1) {
      const value = channelData[channel][i];
      const absolute = value < 0 ? -value : value;
      if (absolute > samplePeak) samplePeak = absolute;
    }
    const bucket = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / length));
    if (samplePeak > peaks[bucket]) peaks[bucket] = samplePeak;
  }
  return peaks;
}

/**
 * 按整段所有桶的最大峰值归一化到 0–1，使最长录音也拥有统一的全局声量参照。
 * 整段静音（最大峰值为 0）时返回全 0，绝不除以 0；纯函数，不修改入参。
 */
export function normalizePeaks(peaks: readonly number[]): number[] {
  let globalMax = 0;
  for (const peak of peaks) {
    if (peak > globalMax) globalMax = peak;
  }
  if (globalMax <= 0) return peaks.map(() => 0);
  return peaks.map((peak) => peak / globalMax);
}

/**
 * 由浏览器解码后的多声道采样构建整段振幅概览：
 * 时长取采样数 / 采样率（与打点、边界校验同一套整数毫秒取整），
 * 峰值跨声道取绝对最大值、按时长等分入桶，再按整段最大值归一化。
 */
export function buildAudioEnvelope(
  channelData: readonly Float32Array[],
  sampleRate: number,
  bucketCount: number,
): AudioEnvelope {
  if (!Array.isArray(channelData) || channelData.length === 0) {
    throw new Error('音频解码结果中没有可用声道，无法生成振幅概览。');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('音频采样率无效，无法按时长等分生成振幅概览。');
  }
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new Error('振幅概览的目标桶数必须是正整数。');
  }
  const durationMs = toMillis(channelData[0].length / sampleRate);
  const peaks = normalizePeaks(collectBucketPeaks(channelData, bucketCount));
  return { durationMs, bucketCount, peaks };
}

/**
 * 轮廓横向比例 → 音频内整数毫秒定位点。比例先钳制到 [0, 1]（NaN 等非有限值
 * 视为 0），换算结果再钳制到 [0, durationMs]。调用方只需给出
 * offsetX / rect.width 之类的横向比例，与画布像素尺寸无关。
 */
export function ratioToPositionMs(ratio: number, durationMs: number): number {
  // NaN 无法表达“左/右端”，按左端处理；±Infinity 则经比例钳制落到端点。
  const sanitized = Number.isNaN(ratio) ? 0 : ratio;
  const clampedRatio = Math.min(1, Math.max(0, sanitized));
  const position = Math.round(clampedRatio * durationMs);
  return Math.min(durationMs, Math.max(0, position));
}

/**
 * 本地振幅分析服务：接收 File 与目标桶数，用 Web Audio 在浏览器本地离线解码
 * （不播放、不发起任何网络请求），各声道绝对峰值按时长等分后归一化。
 * 返回 durationMs、bucketCount 与 0–1 的 peaks；结果只依赖文件内容与桶数，
 * 不依赖画布尺寸或播放进度。任何失败都只返回原因，由调用方在概览区就地说明，
 * 不清空片段、选择或已加载音频。
 */
export async function analyzeAudioEnvelope(
  file: File,
  bucketCount: number,
): Promise<AudioEnvelopeResult> {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    return { ok: false, error: '振幅概览的目标桶数必须是正整数。' };
  }

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    return {
      ok: false,
      error: `文件「${file.name}」读取失败，无法生成振幅概览。`,
    };
  }

  const AudioContextCtor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return {
      ok: false,
      error: '当前浏览器不支持 Web Audio 解码，无法生成振幅概览。',
    };
  }

  // 仅用于离线解码；解码不要求出声，用完立即关闭，不保留任何音频节点。
  const context = new AudioContextCtor();
  try {
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(arrayBuffer);
    } catch {
      return {
        ok: false,
        error: `文件「${file.name}」无法解码为振幅概览，请确认它是可播放的音频文件。`,
      };
    }
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      channels.push(decoded.getChannelData(channel));
    }
    let envelope: AudioEnvelope;
    try {
      envelope = buildAudioEnvelope(channels, decoded.sampleRate, bucketCount);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '振幅概览分析失败。' };
    }
    return { ok: true, envelope };
  } finally {
    void context.close();
  }
}
