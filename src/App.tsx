import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { probeAudioFile } from './lib/audio';
import {
  buildExportPayload,
  createClipId,
  downloadBlob,
  exportClipsAsJson,
  reviseClipInList,
  reviseClipValues,
  type Clip,
} from './lib/clips';
import { parseImportPayload } from './lib/importClips';
import { formatTimecode, toMillis, validateBoundaries, validateLabel } from './lib/time';

interface LoadedAudio {
  file: File;
  url: string;
  durationMs: number;
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audio, setAudio] = useState<LoadedAudio | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  const [pendingStartMs, setPendingStartMs] = useState<number | null>(null);
  const [pendingEndMs, setPendingEndMs] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 当前正在试听的片段 id；null 表示普通播放/未试听。
  const [auditionId, setAuditionId] = useState<string | null>(null);

  // 单一校准编辑态：仅记录正在校准的片段 id；表单值单独保存，预填原记录。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStartText, setEditStartText] = useState('');
  const [editEndText, setEditEndText] = useState('');
  const [editLabel, setEditLabel] = useState('');
  // 校验失败原因只在编辑区内指出，与打点表单的全局 error 互不干扰。
  const [editError, setEditError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const createdCountRef = useRef(0);
  // 导入读取/校验期间为 true：界面显示处理中，并阻止重复触发。
  const [isImporting, setIsImporting] = useState(false);
  const importingRef = useRef(false);
  // 导入是异步的：读取期间若用户更换了音频，据此放弃过期结果。
  const loadedAudioRef = useRef<LoadedAudio | null>(null);
  // 区分用户拖动进度条（或程序定位）与普通 timeupdate。
  const internalSeekRef = useRef(false);
  const auditionRef = useRef<string | null>(null);
  // clips 同步给 rAF 闭包读取，避免每帧重建监听。
  const clipsRef = useRef<Clip[]>([]);
  const loopResumeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    auditionRef.current = auditionId;
  }, [auditionId]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    loadedAudioRef.current = audio;
  }, [audio]);

  /* ------------------------------ 播放位置观测 ------------------------------ */
  // 以 requestAnimationFrame 在播放中持续读取原始 currentTime，保证在
  // 首次达到/越过终点的当帧即可暂停；不向整秒做任何吸附。

  useEffect(() => {
    if (!audio) return;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = audioRef.current;
      if (!el) return;
      const nowMs = toMillis(el.currentTime);
      setCurrentMs(nowMs);

      const activeId = auditionRef.current;
      if (activeId && !el.paused) {
        const active = clipsRef.current.find((c) => c.id === activeId);
        if (active && nowMs >= active.endMs) {
          // 首次观测到达到或越过终点：立即暂停并精确回到记录起点。
          el.pause();
          internalSeekRef.current = true;
          el.currentTime = active.startMs / 1000;
          setCurrentMs(active.startMs);
          // 循环试听：在起点停留一拍后自动从头再来；期间可被“停止试听”取消。
          if (loopResumeTimerRef.current !== null) {
            window.clearTimeout(loopResumeTimerRef.current);
          }
          loopResumeTimerRef.current = window.setTimeout(() => {
            loopResumeTimerRef.current = null;
            const stillEl = audioRef.current;
            if (stillEl && auditionRef.current === active.id) {
              void stillEl.play().catch(() => {
                /* 用户手动暂停等情况，忽略 */
              });
            }
          }, 450);
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (loopResumeTimerRef.current !== null) {
        window.clearTimeout(loopResumeTimerRef.current);
        loopResumeTimerRef.current = null;
      }
    };
  }, [audio]);

  /* ------------------------------- 加载本地音频 ------------------------------- */

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    const result = await probeAudioFile(file);
    if (!result.ok || result.durationMs === undefined) {
      // 不可解码：就地报错，不改变已有音频与片段清单。
      setError(result.error ?? '文件无法解码为音频。');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    // 新音频有效：回收旧 object URL，重置全部打点/播放状态。
    const url = URL.createObjectURL(file);
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { file, url, durationMs: result.durationMs as number };
    });
    if (loopResumeTimerRef.current !== null) {
      window.clearTimeout(loopResumeTimerRef.current);
      loopResumeTimerRef.current = null;
    }
    auditionRef.current = null;
    createdCountRef.current = 0;
    setClips([]);
    setSelectedId(null);
    setAuditionId(null);
    setEditingId(null);
    setEditError(null);
    setPendingStartMs(null);
    setPendingEndMs(null);
    setLabel('');
    setCurrentMs(0);
    setIsPlaying(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const onFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleFile(file);
  };

  /* ------------------------------ 导入片段 JSON ------------------------------ */
  // 载入原音频后，可选择本工具此前导出的 .clips.json 恢复清单继续工作。
  // 校验全部通过才一次性替换清单；任何失败都不改动清单、选择与播放位置。

  const handleImportFile = useCallback(
    async (file: File) => {
      if (!audio || importingRef.current) return;
      importingRef.current = true;
      setIsImporting(true);
      setError(null);
      // 读取/校验是异步的：立即暂停播放并记下导入前位置。
      // 失败时恢复到此位置；成功时被替换片段的试听也就此停止。
      const el = audioRef.current;
      const positionBeforeImportMs = el ? toMillis(el.currentTime) : 0;
      if (loopResumeTimerRef.current !== null) {
        window.clearTimeout(loopResumeTimerRef.current);
        loopResumeTimerRef.current = null;
      }
      if (el && !el.paused) el.pause();
      try {
        const text = await file.text();
        // 读取期间更换了音频：旧音频对应的导入结果直接放弃。
        if (loadedAudioRef.current !== audio) return;
        const result = parseImportPayload(text, audio.file.name, audio.durationMs);
        if (!result.ok) {
          // 解析失败 / 音频不匹配 / 序号重复 / 记录越界：就地报错，
          // 清单与选择不变，播放位置恢复为导入前（保持暂停）。
          setError(result.error);
          if (el) {
            if (!el.paused) el.pause();
            internalSeekRef.current = true;
            el.currentTime = positionBeforeImportMs / 1000;
            setCurrentMs(positionBeforeImportMs);
          }
          return;
        }
        // 全部记录通过：一次性替换清单并选中首条；试听目标随清单作废旧，
        // 且音频保持暂停——被替换片段的试听不会在新清单下继续发声。
        if (el && !el.paused) el.pause();
        auditionRef.current = null;
        setAuditionId(null);
        // 后续创建序号接在已有最大值之后。
        createdCountRef.current = result.nextCreatedAt;
        setClips(result.clips);
        setSelectedId(result.clips[0]?.id ?? null);
        // 清单被整体替换：退出可能正开着的校准编辑态。
        setEditingId(null);
        setEditError(null);
      } finally {
        importingRef.current = false;
        setIsImporting(false);
        // 允许再次选择同一文件。
        if (importInputRef.current) importInputRef.current.value = '';
      }
    },
    [audio],
  );

  const onImportInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleImportFile(file);
  };

  /* --------------------------------- 播放控制 --------------------------------- */

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {
        setError('浏览器拒绝了自动播放，请再次点击播放。');
      });
    } else {
      el.pause();
    }
  };

  // 用户拖动进度条（change 时才真正定位，避免与 rAF 写回竞争）。
  const onScrubberChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el || !audio) return;
    const ms = Number(event.target.value);
    internalSeekRef.current = true;
    el.currentTime = ms / 1000;
    setCurrentMs(ms);
  };

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    if (internalSeekRef.current) {
      internalSeekRef.current = false;
      return;
    }
    setCurrentMs(toMillis(el.currentTime));
  };

  const onEnded = () => {
    // 自然播完：取消试听态，保留在媒体末端。
    setIsPlaying(false);
    setAuditionId(null);
    auditionRef.current = null;
  };

  /* ---------------------------------- 打点 ---------------------------------- */

  const captureStart = () => {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    setPendingStartMs(toMillis(el.currentTime));
  };

  const captureEnd = () => {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    setPendingEndMs(toMillis(el.currentTime));
  };

  const addClip = () => {
    if (!audio) return;
    setError(null);
    const labelError = validateLabel(label);
    if (!labelError.ok) {
      setError(labelError.error ?? '标签不合法。');
      return;
    }
    if (pendingStartMs === null || pendingEndMs === null) {
      setError('请先在播放中分别捕获起点与终点。');
      return;
    }
    const boundaryError = validateBoundaries(pendingStartMs, pendingEndMs, audio.durationMs);
    if (!boundaryError.ok) {
      // 相等/反向/越界：就地报错，清单保持不变。
      setError(boundaryError.error ?? '边界不合法。');
      return;
    }
    const clip: Clip = {
      id: createClipId(),
      startMs: pendingStartMs,
      endMs: pendingEndMs,
      label: label.trim(),
      createdAt: createdCountRef.current,
    };
    createdCountRef.current += 1;
    setClips((prev) => [...prev, clip]);
    setSelectedId(clip.id);
    setPendingStartMs(null);
    setPendingEndMs(null);
    setLabel('');
  };

  /* ------------------------------- 清单：试听/删除 ------------------------------ */

  // 从给定片段的精确起点开始循环试听。校准保存后以新范围调用同一逻辑。
  const auditionClip = useCallback((clip: Clip) => {
    const el = audioRef.current;
    if (!el) return;
    setError(null);
    if (loopResumeTimerRef.current !== null) {
      window.clearTimeout(loopResumeTimerRef.current);
      loopResumeTimerRef.current = null;
    }
    // 试听必须从记录起点开始。
    internalSeekRef.current = true;
    el.currentTime = clip.startMs / 1000;
    setCurrentMs(clip.startMs);
    auditionRef.current = clip.id;
    setAuditionId(clip.id);
    void el.play().catch(() => {
      setError('浏览器拒绝了播放，请再次点击试听。');
    });
  }, []);

  const stopClipAudition = useCallback((clipId: string) => {
    if (auditionRef.current !== clipId) return;
    const el = audioRef.current;
    const clip = clipsRef.current.find((c) => c.id === clipId);
    auditionRef.current = null;
    setAuditionId(null);
    if (loopResumeTimerRef.current !== null) {
      window.clearTimeout(loopResumeTimerRef.current);
      loopResumeTimerRef.current = null;
    }
    if (el && !el.paused) el.pause();
    // 停在精确起点，便于验收者核对游标。
    if (el && clip) {
      internalSeekRef.current = true;
      el.currentTime = clip.startMs / 1000;
      setCurrentMs(clip.startMs);
    }
  }, []);

  const deleteClip = (id: string) => {
    if (auditionRef.current === id) stopClipAudition(id);
    setClips((prev) => prev.filter((c) => c.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
    // 正在校准的记录被删除：连同退出编辑态，避免悬挂的表单。
    if (editingId === id) {
      setEditingId(null);
      setEditError(null);
    }
  };

  /* ----------------------------- 校准（编辑）所选片段 ---------------------------- */
  // 复听后微调：在单一编辑态中预填原标签与整数毫秒边界；确认保存只替换原记录
  // 的起点、终点与标签，id 与创建序号保留，随后仍选中该记录并按新范围循环试听。

  const editingClip = clips.find((c) => c.id === editingId) ?? null;

  // 进入单一编辑态：表单预填原标签与整数毫秒边界。
  const beginEditClip = (clip: Clip) => {
    setError(null);
    setEditingId(clip.id);
    setEditStartText(String(clip.startMs));
    setEditEndText(String(clip.endMs));
    setEditLabel(clip.label);
    setEditError(null);
  };

  const cancelEditClip = () => {
    setEditingId(null);
    setEditError(null);
  };

  // 编辑态中改选其他记录：带着新选中的记录继续校准（仍为单一编辑态）。
  const selectClip = (id: string) => {
    setSelectedId(id);
    if (editingId !== null && editingId !== id) {
      const next = clipsRef.current.find((c) => c.id === id);
      if (next) {
        setEditingId(next.id);
        setEditStartText(String(next.startMs));
        setEditEndText(String(next.endMs));
        setEditLabel(next.label);
        setEditError(null);
      }
    }
  };

  // 整数毫秒解析：表单只接受可选符号开头的整数（与时间码规则一致）。
  const parseEditMs = (text: string, fieldName: string): number | { error: string } => {
    const trimmed = text.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return { error: `${fieldName}必须填写整数毫秒（当前为「${text}」）。` };
    }
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
      return { error: `${fieldName}超出可可靠表示的整数范围。` };
    }
    return value;
  };

  const saveClipEdit = () => {
    if (!audio || !editingClip) return;
    const target = editingClip;
    const startParsed = parseEditMs(editStartText, '起点');
    if (typeof startParsed !== 'number') {
      setEditError(startParsed.error);
      return;
    }
    const endParsed = parseEditMs(editEndText, '终点');
    if (typeof endParsed !== 'number') {
      setEditError(endParsed.error);
      return;
    }
    // 复用与加入片段 / 导入完全相同的标签与毫秒边界规则。
    // 失败只在编辑区指出原因：清单、选择、播放位置与原试听范围一律不变。
    const result = reviseClipValues(
      { startMs: startParsed, endMs: endParsed, label: editLabel },
      audio.durationMs,
    );
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    const revision = { startMs: result.startMs, endMs: result.endMs, label: result.label };
    // 只更新原记录的三字段：reviseClipInList 按 id 就地替换，身份不重建。
    setClips((prev) => reviseClipInList(prev, target.id, revision));
    const updatedClip: Clip = { ...target, ...revision };
    // 保存后仍选中该记录，退出编辑态，立即按新范围从新起点循环试听。
    setSelectedId(updatedClip.id);
    setEditingId(null);
    setEditError(null);
    auditionClip(updatedClip);
  };

  /* ---------------------------------- 导出 ---------------------------------- */

  const exportPayload = useMemo(
    () => (audio ? buildExportPayload(clips, audio.file.name, audio.durationMs) : null),
    [audio, clips],
  );
  const exportPreview = exportPayload ? JSON.stringify(exportPayload, null, 2) : '';

  const handleExport = () => {
    if (!audio || clips.length === 0) return;
    const payload = buildExportPayload(clips, audio.file.name, audio.durationMs);
    const base = audio.file.name.replace(/\.[^.]+$/, '') || 'audio';
    downloadBlob(exportClipsAsJson(payload), `${base}.clips.json`);
  };

  const selectedClip = clips.find((c) => c.id === selectedId) ?? null;
  const auditioningClip = clips.find((c) => c.id === auditionId) ?? null;
  const progressValue = audio ? Math.min(currentMs, audio.durationMs) : 0;

  return (
    <div className="app">
      <header className="header">
        <h1>口述史片段切取校准器</h1>
        <p className="subtitle">
          录音仅在本机读取，不会上传或访问任何在线服务；时间码为 currentTime × 1000
          四舍五入的整数毫秒。
        </p>
      </header>

      <section className="panel" aria-label="音频载入">
        <input
          ref={fileInputRef}
          id="file-input"
          data-testid="file-input"
          type="file"
          accept="audio/*"
          onChange={onFileInputChange}
        />
        {audio && (
          <div className="audio-meta" data-testid="audio-meta">
            <span className="file-name" title={audio.file.name}>
              {audio.file.name}
            </span>
            <span data-testid="duration-ms">时长 {audio.durationMs} ms</span>
            <span className="muted">（{formatTimecode(audio.durationMs)}）</span>
          </div>
        )}
        {error && (
          <div className="error" role="alert" data-testid="error">
            {error}
          </div>
        )}
      </section>

      <section className="panel" aria-label="恢复上次工作">
        <h2>恢复上次工作（导入片段 JSON）</h2>
        <div className="import-row">
          <input
            ref={importInputRef}
            id="import-input"
            data-testid="import-input"
            type="file"
            accept="application/json,.json"
            disabled={!audio || isImporting}
            onChange={onImportInputChange}
          />
          {isImporting && (
            <span className="muted" data-testid="import-status">
              正在读取并校验导入文件…
            </span>
          )}
          {!audio && !isImporting && (
            <span className="muted" data-testid="import-hint">
              先载入原音频，再选择此前导出的 .clips.json；校验通过才会替换当前清单。
            </span>
          )}
        </div>
      </section>

      <section className="panel" aria-label="播放器">
        <audio
          ref={audioRef}
          data-testid="audio-element"
          src={audio?.url}
          preload="auto"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
        />
        <div className="transport" data-playing={isPlaying}>
          <button type="button" data-testid="play-button" onClick={togglePlay} disabled={!audio}>
            {isPlaying ? '暂停' : '播放'}
          </button>
          <input
            type="range"
            data-testid="scrubber"
            min={0}
            max={audio?.durationMs ?? 0}
            step={1}
            value={progressValue}
            disabled={!audio}
            onChange={onScrubberChange}
            aria-label="播放进度（毫秒）"
          />
        </div>
        <div className="time-readout">
          <span data-testid="current-timecode">{formatTimecode(currentMs)}</span>
          <span className="muted" data-testid="current-ms">
            {currentMs} ms
          </span>
          {auditioningClip && (
            <span className="audition-badge" data-testid="audition-badge">
              试听中：{auditioningClip.label}（{auditioningClip.startMs}–{auditioningClip.endMs}{' '}
              ms）
            </span>
          )}
        </div>
      </section>

      <section className="panel" aria-label="打点表单">
        <div className="capture-row">
          <button type="button" data-testid="capture-start" onClick={captureStart} disabled={!audio}>
            捕获起点
          </button>
          <div className="captured" data-testid="pending-start">
            {pendingStartMs === null
              ? '起点未捕获'
              : `${pendingStartMs} ms（${formatTimecode(pendingStartMs)}）`}
          </div>
          <button type="button" data-testid="capture-end" onClick={captureEnd} disabled={!audio}>
            捕获终点
          </button>
          <div className="captured" data-testid="pending-end">
            {pendingEndMs === null
              ? '终点未捕获'
              : `${pendingEndMs} ms（${formatTimecode(pendingEndMs)}）`}
          </div>
        </div>
        <div className="label-row">
          <label htmlFor="label-input">标签（必填，非空）</label>
          <input
            id="label-input"
            data-testid="label-input"
            type="text"
            value={label}
            placeholder="例如：受访者讲述搬迁那年的片段"
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="button" data-testid="add-clip" onClick={addClip} disabled={!audio}>
            加入片段
          </button>
        </div>
      </section>

      <section className="panel" aria-label="片段清单">
        <div className="clip-list-header">
          <h2>片段清单（{clips.length}）</h2>
          <button
            type="button"
            data-testid="edit-selected-clip"
            onClick={() => selectedClip && beginEditClip(selectedClip)}
            disabled={!selectedClip || editingId !== null}
          >
            校准所选片段
          </button>
        </div>
        {clips.length === 0 ? (
          <p className="muted" data-testid="empty-list">
            还没有片段。播放录音，分别捕获起点、终点并填写标签后加入。
          </p>
        ) : (
          <ul className="clip-list" data-testid="clip-list">
            {clips.map((clip) => (
              <li
                key={clip.id}
                className={`clip-item ${selectedId === clip.id ? 'selected' : ''} ${
                  auditionId === clip.id ? 'auditioning' : ''
                }`}
                data-testid="clip-item"
                data-clip-id={clip.id}
              >
                <label className="clip-select">
                  <input
                    type="radio"
                    name="selected-clip"
                    data-testid="clip-select"
                    checked={selectedId === clip.id}
                    onChange={() => selectClip(clip.id)}
                  />
                </label>
                <div className="clip-info">
                  <span className="clip-label" data-testid="clip-label">
                    {clip.label}
                  </span>
                  <span className="clip-bounds" data-testid="clip-bounds">
                    {clip.startMs} ms → {clip.endMs} ms（长 {clip.endMs - clip.startMs} ms，
                    {formatTimecode(clip.startMs)} – {formatTimecode(clip.endMs)}）
                  </span>
                </div>
                <button type="button" data-testid="audition-clip" onClick={() => auditionClip(clip)}>
                  循环试听
                </button>
                <button
                  type="button"
                  data-testid="stop-audition"
                  onClick={() => stopClipAudition(clip.id)}
                  disabled={auditionId !== clip.id}
                >
                  停止试听
                </button>
                <button
                  type="button"
                  className="danger"
                  data-testid="delete-clip"
                  onClick={() => deleteClip(clip.id)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}

        {editingClip && (
          <form
            className="clip-editor"
            data-testid="clip-editor"
            aria-label="校准所选片段"
            onSubmit={(e) => {
              e.preventDefault();
              saveClipEdit();
            }}
          >
            <h3 data-testid="clip-editor-title">
              校准片段（创建序号 {editingClip.createdAt}）
            </h3>
            <p className="muted clip-editor-hint">
              表单已预填原标签与整数毫秒边界；保存只更新该记录的起点、终点与标签，页面标识与创建序号不变。
            </p>
            <div className="editor-row">
              <label htmlFor="edit-start-input">起点（整数毫秒）</label>
              <input
                id="edit-start-input"
                data-testid="edit-start-input"
                type="number"
                inputMode="numeric"
                step={1}
                value={editStartText}
                onChange={(e) => setEditStartText(e.target.value)}
              />
              <span className="muted" data-testid="edit-start-timecode">
                {/^[+-]?\d+$/.test(editStartText.trim())
                  ? formatTimecode(Number(editStartText.trim()))
                  : '—'}
              </span>
            </div>
            <div className="editor-row">
              <label htmlFor="edit-end-input">终点（整数毫秒）</label>
              <input
                id="edit-end-input"
                data-testid="edit-end-input"
                type="number"
                inputMode="numeric"
                step={1}
                value={editEndText}
                onChange={(e) => setEditEndText(e.target.value)}
              />
              <span className="muted" data-testid="edit-end-timecode">
                {/^[+-]?\d+$/.test(editEndText.trim())
                  ? formatTimecode(Number(editEndText.trim()))
                  : '—'}
              </span>
            </div>
            <div className="editor-row">
              <label htmlFor="edit-label-input">标签（必填，非空）</label>
              <input
                id="edit-label-input"
                data-testid="edit-label-input"
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
              />
            </div>
            {editError && (
              <div className="error edit-error" role="alert" data-testid="edit-error">
                {editError}
              </div>
            )}
            <div className="editor-actions">
              <button type="submit" data-testid="save-clip-edit">
                确认保存
              </button>
              <button
                type="button"
                data-testid="cancel-clip-edit"
                onClick={cancelEditClip}
              >
                取消
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel" aria-label="导出">
        <div className="export-row">
          <button
            type="button"
            data-testid="export-json"
            onClick={handleExport}
            disabled={!audio || clips.length === 0}
          >
            导出 JSON（按起点、终点、创建序号升序）
          </button>
          {selectedClip && (
            <span className="muted" data-testid="selected-created-at">
              已选片段创建序号：{selectedClip.createdAt}
            </span>
          )}
        </div>
        {exportPreview && (
          <pre className="export-preview" data-testid="export-preview">
            {exportPreview}
          </pre>
        )}
      </section>

      <footer className="footer muted">
        试听规则：从记录起点开始播放，首次观测到当前毫秒 ≥ 终点即暂停并回到起点，随后循环；全程不吸附整秒。
      </footer>
    </div>
  );
}
