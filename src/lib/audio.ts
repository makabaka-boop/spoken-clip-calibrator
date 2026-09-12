import { toMillis } from './time';

export interface AudioProbeResult {
  ok: boolean;
  /** 与打点完全相同的取整规则得到的整数毫秒时长。 */
  durationMs?: number;
  error?: string;
}

/**
 * 只在本地探测用户选择的音频：经 object URL 交给 HTMLMediaElement，
 * 不发起任何网络请求。不可解码（error 事件）或时长为
 * Infinity/NaN（例如缺元数据又无法估算长度）都视为失败。
 */
export function probeAudioFile(file: File): Promise<AudioProbeResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish({ ok: false, error: `文件「${file.name}」加载超时，无法作为音频打开。` });
    }, 15000);

    const cleanup = () => {
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };

    const finish = (result: AudioProbeResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    audio.preload = 'auto';

    audio.onerror = () => {
      finish({
        ok: false,
        error: `文件「${file.name}」无法解码为音频，请选择可播放的音频文件。`,
      });
    };

    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        finish({
          ok: false,
          error: `文件「${file.name}」无法确定有效时长，可能不是可解码的音频。`,
        });
        return;
      }
      finish({ ok: true, durationMs: toMillis(duration) });
    };

    audio.src = url;
    audio.load();
  });
}
