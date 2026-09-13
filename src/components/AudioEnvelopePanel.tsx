import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatTimecode } from '../lib/time';
import { ratioToPositionMs, type AudioEnvelope } from '../lib/audioEnvelope';

interface AudioEnvelopePanelProps {
  /** 当前载入音频的整数毫秒时长：定位结果钳制到该值，与打点/片段边界同源。 */
  durationMs: number;
  envelope: AudioEnvelope | null;
  /** 分析中 / 可用 / 失败三态；失败原因只在本概览区说明。 */
  state: 'analyzing' | 'available' | 'failed';
  error: string | null;
  /** 共享播放位置（毫秒），只用于叠加只读游标，不参与分析。 */
  currentMs: number;
  /** 点击/键盘定位：由 App 先结束单条或顺序审听，再把共享播放器定位到整数毫秒。 */
  onSeek: (ms: number) => void;
}

/**
 * 本地音频振幅概览：把独立的 AudioEnvelope 数据画成整段峰值轮廓。
 * 数据（分桶/归一化）与画布像素尺寸完全无关：绘制时按当前 CSS 宽度逐桶映射，
 * 播放进度只叠加一条只读游标。轮廓可聚焦、有键盘等价操作与时间提示。
 */
export default function AudioEnvelopePanel({
  durationMs,
  envelope,
  state,
  error,
  currentMs,
  onSeek,
}: AudioEnvelopePanelProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  // 键盘导航位置：独立于真实播放位置，供 aria-valuenow 与时间提示宣读。
  const [focusMs, setFocusMs] = useState<number | null>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  // 随容器宽度变化重绘；分析结果本身不随尺寸变化。
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => setWidth(wrap.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [state, envelope]);

  // 每次轮廓或尺寸变化时按设备像素比重绘，保证高分屏清晰。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || state !== 'available' || !envelope) return;
    const cssWidth = Math.max(1, width);
    const cssHeight = 72;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const bucketCount = envelope.peaks.length;
    // 逐桶映射宽度：等宽细条，间隙至少 1 物理像素；桶远多于像素时条宽取 1。
    const barWidth = cssWidth / bucketCount;
    const drawWidth = Math.max(1, barWidth - Math.min(1, barWidth / 2));
    for (let i = 0; i < bucketCount; i += 1) {
      const peak = envelope.peaks[i];
      const barHeight = Math.max(2, Math.round(peak * (cssHeight - 8)));
      const x = i * barWidth;
      const y = cssHeight - barHeight;
      ctx.fillStyle = '#5aa7ff';
      ctx.fillRect(x, y, drawWidth, barHeight);
    }

    // 只读播放游标：只反映共享播放器位置，不改变分析数据。
    if (durationMs > 0) {
      const playheadX = Math.min(cssWidth, (currentMs / durationMs) * cssWidth);
      ctx.fillStyle = 'rgba(232, 235, 240, 0.85)';
      ctx.fillRect(Math.max(0, playheadX - 0.75), 0, 1.5, cssHeight);
    }
  }, [state, envelope, width, currentMs, durationMs]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (clientX - rect.left) / rect.width;
      onSeek(ratioToPositionMs(ratio, durationMs));
    },
    [durationMs, onSeek],
  );

  // 键盘等价操作：左右移动 1% 时长（至少 1 ms，绝不吸附整秒），Home/End 到端点。
  const nudge = useCallback(
    (delta: number) => {
      const next = Math.min(durationMs, Math.max(0, (focusMs ?? currentMs) + delta));
      setFocusMs(next);
      onSeek(next);
    },
    [durationMs, focusMs, currentMs, onSeek],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (state !== 'available') return;
    const step = Math.max(1, Math.round(durationMs / 100));
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        nudge(-step);
        break;
      case 'ArrowRight':
        event.preventDefault();
        nudge(step);
        break;
      case 'Home':
        event.preventDefault();
        setFocusMs(0);
        onSeek(0);
        break;
      case 'End':
        event.preventDefault();
        setFocusMs(durationMs);
        onSeek(durationMs);
        break;
      default:
        break;
    }
  };

  const hintMs = hoverMs ?? focusMs;
  const available = state === 'available' && envelope;

  return (
    <div className="envelope" data-testid="audio-envelope">
      <div className="envelope-head">
        <h2>整段振幅概览</h2>
        <span className="muted" data-testid="envelope-summary">
          {state === 'available' && envelope
            ? `${envelope.bucketCount} 个等分时段 · 点击轮廓定位`
            : state === 'analyzing'
              ? '正在本地解码并统计整段峰值…'
              : '振幅概览不可用'}
        </span>
      </div>

      {state === 'analyzing' && (
        <div
          className="envelope-status muted"
          role="status"
          data-testid="envelope-analyzing"
          aria-live="polite"
        >
          正在分析本地音频的整段峰值轮廓，请稍候…
        </div>
      )}

      {state === 'failed' && (
        <div
          className="envelope-status envelope-error"
          role="alert"
          data-testid="envelope-error"
        >
          {error ?? '振幅概览分析失败。'}
        </div>
      )}

      {available && (
        <>
          <div ref={wrapRef} className="envelope-canvas-wrap">
            <canvas
              ref={canvasRef}
              data-testid="envelope-canvas"
              role="slider"
              tabIndex={0}
              aria-label="整段峰值轮廓：点击或用左右方向键定位播放位置"
              aria-valuemin={0}
              aria-valuemax={durationMs}
              aria-valuenow={focusMs ?? Math.min(currentMs, durationMs)}
              aria-valuetext={`${focusMs ?? Math.min(currentMs, durationMs)} 毫秒（${formatTimecode(
                focusMs ?? Math.min(currentMs, durationMs),
              )}）`}
              onClick={(event) => seekFromClientX(event.clientX)}
              onMouseMove={(event) => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                if (rect.width <= 0) return;
                setHoverMs(ratioToPositionMs((event.clientX - rect.left) / rect.width, durationMs));
              }}
              onMouseLeave={() => setHoverMs(null)}
              onFocus={() => setFocusMs((prev) => prev ?? Math.min(currentMs, durationMs))}
              onKeyDown={onKeyDown}
            />
          </div>
          <p className="muted envelope-hint" data-testid="envelope-time-hint" aria-live="polite">
            {hintMs === null
              ? '点击轮廓任意位置可把播放定位到对应整数毫秒；方向键逐段移动，Home/End 到首尾。'
              : `位置 ${hintMs} ms（${formatTimecode(hintMs)}）`}
          </p>
        </>
      )}
    </div>
  );
}
