/**
 * 录音器：长按说话。MediaRecorder + AnalyserNode 实时音量（画波形）。
 * 只产出音频 Blob，不做任何上传；上传由调用方决定（服务端 /api/asr 或直连云 ASR）。
 */

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/aac',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* ignore */ }
  }
  return '';
}

export function recorderSupported() {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined';
}

/**
 * @param {{
 *   maxMs?: number,
 *   onTick?: (elapsedMs:number)=>void,
 *   onLevel?: (level:number)=>void,
 *   onError?: (message:string)=>void,
 *   onAutoStop?: ()=>void,
 * }} opts
 */
export function createRecorder(opts = {}) {
  const maxMs = opts.maxMs || 60000;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let levelTimer = null;
  let tickTimer = null;
  let startedAt = 0;
  let recording = false;
  let cancelled = false;

  function cleanup() {
    recording = false;
    if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch { /* ignore */ } }
      stream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch { /* ignore */ }
      audioCtx = null;
    }
    analyser = null;
  }

  function measureLevel() {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    return Math.max(0, Math.min(1, rms * 3.2));
  }

  return {
    isRecording: () => recording,
    elapsed: () => (recording ? Date.now() - startedAt : 0),

    /** 开始录音（需要用户手势触发以保证麦克风权限） */
    async start() {
      if (recording) return;
      if (!recorderSupported()) {
        const msg = '当前环境不支持录音，请改用文字输入';
        opts.onError?.(msg);
        throw new Error(msg);
      }
      cancelled = false;
      chunks = [];
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      const mime = pickMime();
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onerror = (e) => opts.onError?.(`录音出错：${e.error?.name || '未知错误'}`);
      recorder.start(250);

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
      } catch {
        analyser = null; // 没波形也能录
      }

      recording = true;
      startedAt = Date.now();
      levelTimer = setInterval(() => opts.onLevel?.(measureLevel()), 90);
      tickTimer = setInterval(() => {
        const ms = Date.now() - startedAt;
        opts.onTick?.(ms);
        if (ms >= maxMs) {
          opts.onAutoStop?.();
        }
      }, 200);
    },

    /**
     * 停止并拿到音频。
     * @param {boolean} [discard]
     * @returns {Promise<{blob:Blob, mime:string, durationMs:number}|null>}
     */
    stop(discard = false) {
      return new Promise((resolve) => {
        if (!recorder || !recording) {
          cleanup();
          resolve(null);
          return;
        }
        cancelled = discard;
        const durationMs = Date.now() - startedAt;
        const mime = recorder.mimeType || pickMime() || 'audio/webm';
        recorder.onstop = () => {
          const blob = cancelled ? null : new Blob(chunks, { type: mime });
          cleanup();
          if (!blob || blob.size < 800) resolve(null);
          else resolve({ blob, mime, durationMs });
        };
        try { recorder.stop(); } catch { cleanup(); resolve(null); }
      });
    },

    cancel() {
      return this.stop(true);
    },
  };
}
