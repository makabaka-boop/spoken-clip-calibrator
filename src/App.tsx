import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AudioEnvelopePanel from './components/AudioEnvelopePanel';
import { probeAudioFile } from './lib/audio';
import {
  analyzeAudioEnvelope,
  type AudioEnvelope,
  type AudioEnvelopeState,
} from './lib/audioEnvelope';
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
import {
  IDLE_SEQUENTIAL_SESSION,
  beginNextClip,
  buildSequentialQueue,
  clipReachedEnd,
  currentSequentialId,
  startSequentialSession,
  stopSequentialSession,
  type SequentialSession,
} from './lib/sequentialAudition';
import { formatTimecode, toMillis, validateBoundaries, validateLabel } from './lib/time';

interface LoadedAudio {
  file: File;
  url: string;
  durationMs: number;
}

// 整段峰值轮廓的等分桶数：只影响轮廓数据粒度，与画布尺寸/播放进度无关。
const ENVELOPE_BUCKET_COUNT = 240;

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
  // 顺序审听会话：只有空闲 / 播放当前片段 / 切换下一片段三种状态；
  // 空闲态保留队列与 index，游标因此停在当前（或末条）片段起点。
  const [sequential, setSequential] = useState<SequentialSession>(IDLE_SEQUENTIAL_SESSION);
  // 顺序审听失败时在清单旁说明的失败片段；已保存记录与顺序不变，可从当前选择重试。
  const [sequentialNote, setSequentialNote] = useState<string | null>(null);

  // 单一校准编辑态：仅记录正在校准的片段 id；表单值单独保存，预填原记录。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStartText, setEditStartText] = useState('');
  const [editEndText, setEditEndText] = useState('');
  const [editLabel, setEditLabel] = useState('');
  // 校验失败原因只在编辑区内指出，与打点表单的全局 error 互不干扰。
  const [editError, setEditError] = useState<string | null>(null);

  // 独立的整段振幅概览：分析中 / 可用 / 失败三态；失败只在概览区说明原因，
  // 不清空片段、选择或已加载音频。更换音频时清除旧概览并忽略迟到结果。
  const [envelope, setEnvelope] = useState<AudioEnvelope | null>(null);
  const [envelopeState, setEnvelopeState] = useState<AudioEnvelopeState>('analyzing');
  const [envelopeError, setEnvelopeError] = useState<string | null>(null);
  const envelopeRunRef = useRef(0);

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
  // 顺序审听会话同步给 rAF / 定时器闭包读取；切换停留由独立定时器负责。
  const sequentialRef = useRef<SequentialSession>(IDLE_SEQUENTIAL_SESSION);
  const sequentialSwitchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    auditionRef.current = auditionId;
  }, [auditionId]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    sequentialRef.current = sequential;
  }, [sequential]);

  useEffect(() => {
    loadedAudioRef.current = audio;
  }, [audio]);

  /* ------------------------------ 整段振幅概览 ------------------------------ */
  // 音频载入后自动分析：浏览器本地离线解码，按时长等分各声道绝对峰值。
  // 更换音频会清除旧概览，并以递增 run id 忽略上一段音频的迟到结果；
  // 分析失败只在概览区说明，片段、选择与已加载音频一律不变。
  useEffect(() => {
    if (!audio) {
      envelopeRunRef.current += 1;
      setEnvelope(null);
      setEnvelopeError(null);
      setEnvelopeState('analyzing');
      return;
    }
    const runId = envelopeRunRef.current + 1;
    envelopeRunRef.current = runId;
    setEnvelope(null);
    setEnvelopeError(null);
    setEnvelopeState('analyzing');
    let cancelled = false;

    void analyzeAudioEnvelope(audio.file, ENVELOPE_BUCKET_COUNT).then((result) => {
      // 更换音频（effect cleanup）后到达的旧结果直接丢弃。
      if (cancelled || envelopeRunRef.current !== runId) return;
      if (result.ok && result.envelope) {
        setEnvelope(result.envelope);
        setEnvelopeError(null);
        setEnvelopeState('available');
      } else {
        setEnvelope(null);
        setEnvelopeError(result.error ?? '振幅概览分析失败。');
        setEnvelopeState('failed');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [audio]);

  /* ------------------------------ 播放位置观测 ------------------------------ */
  // 以 requestAnimationFrame 在播放中持续读取原始 currentTime，保证在
  // 首次达到/越过终点的当帧即可暂停；不向整秒做任何吸附。

  const clearSequentialSwitchTimer = useCallback(() => {
    if (sequentialSwitchTimerRef.current !== null) {
      window.clearTimeout(sequentialSwitchTimerRef.current);
      sequentialSwitchTimerRef.current = null;
    }
  }, []);

  // 推进到下一条：选中并从其精确起点播放；媒体拒绝播放则结束本次顺序审听，
  // 已保存记录及其顺序不变，用户仍可从当前选择重试。
  // 切换停留定时器与切换停留期间的共享“播放”按钮都经由此处推进。
  const advanceSequentialToNextClip = useCallback(() => {
    clearSequentialSwitchTimer();
    const switched = beginNextClip(sequentialRef.current);
    if (switched.phase !== 'playing') return;
    const target = clipsRef.current.find((c) => c.id === currentSequentialId(switched));
    const el = audioRef.current;
    if (!target || !el) return;
    setSelectedId(target.id);
    sequentialRef.current = switched;
    setSequential(switched);
    internalSeekRef.current = true;
    el.currentTime = target.startMs / 1000;
    setCurrentMs(target.startMs);
    void el.play().catch(() => {
      const failed = stopSequentialSession(sequentialRef.current);
      sequentialRef.current = failed;
      setSequential(failed);
      setSequentialNote(
        `顺序审听在片段「${target.label}」处被浏览器拒绝播放，已终止；记录与顺序未改变，可从该片段重新开始。`,
      );
    });
  }, [clearSequentialSwitchTimer]);

  // 当前片段首次达到终点后的推进：暂停并复位到当前片段精确起点，再做会话
  // 推演——末条收束（空闲，停在末条起点），其余进入切换停留。
  const settleSequentialClipEnd = useCallback(() => {
    const session = sequentialRef.current;
    if (session.phase !== 'playing') return;
    const currentId = currentSequentialId(session);
    const current = clipsRef.current.find((c) => c.id === currentId);
    const el = audioRef.current;
    if (!current) return;
    if (el && !el.paused) el.pause();
    if (el) {
      internalSeekRef.current = true;
      el.currentTime = current.startMs / 1000;
    }
    setCurrentMs(current.startMs);
    const next = clipReachedEnd(session);
    sequentialRef.current = next;
    setSequential(next);
    if (next.phase !== 'switching') return;
    // 切换下一片段前稍作停留；停留期间点共享“播放”会立即推进（见 togglePlay）。
    clearSequentialSwitchTimer();
    sequentialSwitchTimerRef.current = window.setTimeout(() => {
      sequentialSwitchTimerRef.current = null;
      advanceSequentialToNextClip();
    }, 450);
  }, [clearSequentialSwitchTimer, advanceSequentialToNextClip]);

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

      // 顺序审听：与单条循环复用同一毫秒换算与终点判定，但不循环——
      // 暂停复位后推进到下一条，末条收束退出。
      const session = sequentialRef.current;
      if (session.phase === 'playing' && !el.paused) {
        const current = clipsRef.current.find(
          (c) => c.id === currentSequentialId(session),
        );
        if (current && nowMs >= current.endMs) {
          settleSequentialClipEnd();
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
      clearSequentialSwitchTimer();
    };
  }, [audio, clearSequentialSwitchTimer, settleSequentialClipEnd]);

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
    clearSequentialSwitchTimer();
    auditionRef.current = null;
    createdCountRef.current = 0;
    setClips([]);
    setSelectedId(null);
    setAuditionId(null);
    sequentialRef.current = IDLE_SEQUENTIAL_SESSION;
    setSequential(IDLE_SEQUENTIAL_SESSION);
    setSequentialNote(null);
    setEditingId(null);
    setEditError(null);
    setPendingStartMs(null);
    setPendingEndMs(null);
    setLabel('');
    setCurrentMs(0);
    setIsPlaying(false);
    // 更换音频：清除旧概览，使上一段音频迟到的分析结果作废（effect 会再次置位）。
    envelopeRunRef.current += 1;
    setEnvelope(null);
    setEnvelopeError(null);
    setEnvelopeState('analyzing');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [clearSequentialSwitchTimer]);

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
      clearSequentialSwitchTimer();
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
        // 清单被整体替换：进行中的顺序审听随之终止，旧队列不再有效。
        clearSequentialSwitchTimer();
        sequentialRef.current = IDLE_SEQUENTIAL_SESSION;
        setSequential(IDLE_SEQUENTIAL_SESSION);
        setSequentialNote(null);
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
    [audio, clearSequentialSwitchTimer],
  );

  const onImportInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleImportFile(file);
  };

  /* --------------------------------- 播放控制 --------------------------------- */

  // 振幅概览定位：定位前结束正在进行的单条循环试听或顺序审听（含各自的
  // 自动续播/切换定时器），再把共享播放器定位到换算并钳制后的整数毫秒。
  // 不改变片段、选择或校准编辑态；播放器保持暂停，用户自行继续播放。
  const seekFromEnvelope = useCallback(
    (ms: number) => {
      const el = audioRef.current;
      if (!el || !audio) return;
      const targetMs = Math.min(audio.durationMs, Math.max(0, Math.round(ms)));
      if (loopResumeTimerRef.current !== null) {
        window.clearTimeout(loopResumeTimerRef.current);
        loopResumeTimerRef.current = null;
      }
      clearSequentialSwitchTimer();
      if (!el.paused) el.pause();
      auditionRef.current = null;
      setAuditionId(null);
      const idle = stopSequentialSession(sequentialRef.current);
      sequentialRef.current = idle;
      setSequential(idle);
      internalSeekRef.current = true;
      el.currentTime = targetMs / 1000;
      setCurrentMs(targetMs);
    },
    [audio, clearSequentialSwitchTimer],
  );

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // 顺序审听切换停留期间，游标停在刚播完片段的起点：直接播放会让刚结束的
      // 记录再次发声。此时“播放”意为立即推进——只播放即将切换到的下一条。
      if (sequentialRef.current.phase === 'switching') {
        advanceSequentialToNextClip();
        return;
      }
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
    // 顺序审听播放当前片段时，拖动越过终点不得触发提前结算：游标回到当前片段
    // 的精确起点继续播放，该片段仍依照既定边界完成审听后才推进。
    const session = sequentialRef.current;
    if (session.phase === 'playing') {
      const current = clipsRef.current.find((c) => c.id === currentSequentialId(session));
      if (current && ms >= current.endMs) {
        internalSeekRef.current = true;
        el.currentTime = current.startMs / 1000;
        setCurrentMs(current.startMs);
        return;
      }
    }
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
    // 顺序审听中片段终点恰为媒体末端时不会再有 rAF 推进帧，执行同样的收束
    // （暂停复位 + 推进/退出；此时媒体已在末端，回放定位由收束逻辑完成）。
    settleSequentialClipEnd();
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
    // 顺序审听进行中：选择必须始终对应播放目标（由会话推进驱动），
    // 新增记录不抢走选择；空闲时沿用“新增即选中新记录”的既有行为。
    if (sequentialRef.current.phase === 'idle') {
      setSelectedId(clip.id);
    }
    setPendingStartMs(null);
    setPendingEndMs(null);
    setLabel('');
  };

  /* ------------------------------- 清单：试听/删除 ------------------------------ */

  // 结束顺序审听但不复位游标（循环试听、删除等另有定位/语义的场景使用）。
  const endSequentialWithoutReset = useCallback(() => {
    if (sequentialRef.current.phase === 'idle') return;
    clearSequentialSwitchTimer();
    const idle = stopSequentialSession(sequentialRef.current);
    sequentialRef.current = idle;
    setSequential(idle);
  }, [clearSequentialSwitchTimer]);

  // 媒体进入暂停时：若顺序审听仍处于“播放当前片段”，说明暂停来自会话逻辑
  // 之外（如共享播放按钮）——会话同步退出顺序审听，游标停在用户暂停处。
  // 会话自身的暂停（到终点结算、停止试听、导入）都先把会话状态同步更新，
  // pause 事件异步到达时相位已不再是 playing，不会误判；自然播完只有 ended
  // 事件，且由 onEnded 的收束逻辑负责，这里以 el.ended 兜底排除。
  const onPause = () => {
    setIsPlaying(false);
    const el = audioRef.current;
    if (!el || el.ended) return;
    if (sequentialRef.current.phase === 'playing') {
      endSequentialWithoutReset();
    }
  };

  // 顺序审听：从选中记录开始，按导出排序连续审听当前项与后续项。
  const startSequentialAudition = () => {
    const el = audioRef.current;
    if (!el || !selectedClip || sequentialRef.current.phase !== 'idle') return;
    setError(null);
    setSequentialNote(null);
    const queue = buildSequentialQueue(clipsRef.current, selectedClip.id);
    const session = startSequentialSession(queue ?? []);
    if (!session) return;
    if (loopResumeTimerRef.current !== null) {
      window.clearTimeout(loopResumeTimerRef.current);
      loopResumeTimerRef.current = null;
    }
    auditionRef.current = null;
    setAuditionId(null);
    setSelectedId(selectedClip.id);
    sequentialRef.current = session;
    setSequential(session);
    // 从选中片段的精确起点开始播放。
    internalSeekRef.current = true;
    el.currentTime = selectedClip.startMs / 1000;
    setCurrentMs(selectedClip.startMs);
    void el.play().catch(() => {
      // 开始播放即被媒体拒绝：结束本次顺序审听并在清单旁说明，
      // 已保存记录及其顺序不变，用户仍可从当前选择重试。
      const failed = stopSequentialSession(sequentialRef.current);
      sequentialRef.current = failed;
      setSequential(failed);
      setSequentialNote(
        `顺序审听在片段「${selectedClip.label}」处被浏览器拒绝播放，已终止；记录与顺序未改变，可从该片段重新开始。`,
      );
    });
  };

  // 顺序审听中途终止：随时可点当前片段的既有“停止试听”，游标回到当前片段起点。
  const stopSequentialAudition = useCallback(() => {
    const session = sequentialRef.current;
    if (session.phase === 'idle') return;
    const clip = clipsRef.current.find((c) => c.id === currentSequentialId(session));
    clearSequentialSwitchTimer();
    const el = audioRef.current;
    if (el && !el.paused) el.pause();
    if (el && clip) {
      internalSeekRef.current = true;
      el.currentTime = clip.startMs / 1000;
      setCurrentMs(clip.startMs);
    }
    const idle = stopSequentialSession(session);
    sequentialRef.current = idle;
    setSequential(idle);
  }, [clearSequentialSwitchTimer]);

  // 从给定片段的精确起点开始循环试听。校准保存后以新范围调用同一逻辑。
  const auditionClip = useCallback(
    (clip: Clip) => {
      const el = audioRef.current;
      if (!el) return;
      setError(null);
      // 单条循环试听与顺序审听互斥：启动循环即终止可能正在进行的顺序审听，
      // 单条循环试听自身的行为（复位、循环、停止）保持原样。
      endSequentialWithoutReset();
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
    },
    [endSequentialWithoutReset],
  );

  // 既有“停止试听”：结束单条循环试听或顺序审听；顺序审听时游标回到当前片段起点。
  const stopClipAudition = useCallback(
    (clipId: string) => {
      const isSequentialTarget =
        sequentialRef.current.phase !== 'idle' &&
        currentSequentialId(sequentialRef.current) === clipId;
      if (auditionRef.current === clipId) {
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
      } else if (isSequentialTarget) {
        stopSequentialAudition();
      }
    },
    [stopSequentialAudition],
  );

  const deleteClip = (id: string) => {
    if (auditionRef.current === id) stopClipAudition(id);
    // 删除顺序审听队列中的记录：终止会话，避免悬挂到已不存在的片段。
    if (
      sequentialRef.current.phase !== 'idle' &&
      sequentialRef.current.queue.includes(id)
    ) {
      endSequentialWithoutReset();
    }
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
    // 顺序审听进行中选择随播放自动推进，忽略手动改选以免游标与播放脱节。
    if (sequentialRef.current.phase !== 'idle') return;
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
  // 顺序审听派生视图：进行中（播放/切换）、当前片段与入口可用性。
  const sequentialActive = sequential.phase !== 'idle';
  const sequentialCurrentId = currentSequentialId(sequential);
  const sequentialCurrentClip =
    clips.find((c) => c.id === sequentialCurrentId) ?? null;
  const sequentialEntryAvailable =
    !!audio && clips.length > 0 && !!selectedClip && !sequentialActive;
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
          onPause={onPause}
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
          {sequentialActive && sequentialCurrentClip && (
            <span className="sequential-badge" data-testid="sequential-badge">
              顺序审听（{sequential.phase === 'switching' ? '切换下一片段' : '播放当前片段'}）：
              {sequentialCurrentClip.label}（{sequential.index + 1}/{sequential.queue.length}）
            </span>
          )}
        </div>
      </section>

      {audio && (
        <section className="panel" aria-label="整段振幅概览">
          <AudioEnvelopePanel
            durationMs={audio.durationMs}
            envelope={envelope}
            state={envelopeState}
            error={envelopeError}
            currentMs={currentMs}
            onSeek={seekFromEnvelope}
          />
        </section>
      )}

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
          <div className="clip-list-actions">
            <button
              type="button"
              data-testid="sequential-audition"
              onClick={startSequentialAudition}
              disabled={!sequentialEntryAvailable}
              title={
                sequentialActive
                  ? '顺序审听进行中，可点当前片段的“停止试听”终止'
                  : '从选中记录开始，按导出排序连续审听当前项与后续项'
              }
            >
              顺序审听
            </button>
            <button
              type="button"
              data-testid="edit-selected-clip"
              onClick={() => selectedClip && beginEditClip(selectedClip)}
              disabled={!selectedClip || editingId !== null || sequentialActive}
            >
              校准所选片段
            </button>
          </div>
        </div>
        {sequentialNote && (
          <div className="error sequential-note" role="alert" data-testid="sequential-note">
            {sequentialNote}
          </div>
        )}
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
                } ${sequentialActive && sequentialCurrentId === clip.id ? 'sequential-on' : ''}`}
                data-testid="clip-item"
                data-clip-id={clip.id}
              >
                <label className="clip-select">
                  <input
                    type="radio"
                    name="selected-clip"
                    data-testid="clip-select"
                    checked={selectedId === clip.id}
                    disabled={sequentialActive}
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
                <button
                  type="button"
                  data-testid="audition-clip"
                  onClick={() => auditionClip(clip)}
                  disabled={sequentialActive}
                >
                  循环试听
                </button>
                <button
                  type="button"
                  data-testid="stop-audition"
                  onClick={() => stopClipAudition(clip.id)}
                  disabled={
                    auditionId === clip.id
                      ? false
                      : !(sequentialActive && sequentialCurrentId === clip.id)
                  }
                >
                  停止试听
                </button>
                <button
                  type="button"
                  className="danger"
                  data-testid="delete-clip"
                  onClick={() => deleteClip(clip.id)}
                  disabled={sequentialActive}
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
        「顺序审听」从选中记录开始，按起点、终点、创建序号排序连续审听当前项与后续项：每条到终点暂停复位后
        自动选中并播放下一条，末条结束后停在其起点并退出；随时点当前片段的「停止试听」可终止并回到当前片段起点。
      </footer>
    </div>
  );
}
