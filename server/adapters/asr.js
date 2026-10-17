/**
 * 语音识别适配器：OpenAI 兼容的 /v1/audio/transcriptions。
 * 兼容 OpenAI / 硅基流动 / Groq / 本地 faster-whisper-server 等（只改 .env 的 baseUrl 与 Key）。
 * 未配置时返回 null，前端会提示改用文字输入。
 */

export function createASR(cfg) {
  if (cfg.asrProvider !== 'openai-compatible' || !cfg.asrBaseUrl) return null;
  const base = String(cfg.asrBaseUrl).replace(/\/+$/, '');
  const endpoint = /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`;

  return {
    provider: 'openai-compatible',
    model: cfg.asrModel || 'whisper-1',
    /**
     * @param {Buffer} buffer 音频二进制
     * @param {string} mime 音频 MIME
     * @param {{durationMs?:number, language?:string}} [opts]
     */
    async transcribe(buffer, mime = 'audio/webm', opts = {}) {
      const form = new FormData();
      const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'webm';
      form.append('file', new Blob([buffer], { type: mime }), `audio.${ext}`);
      form.append('model', cfg.asrModel || 'whisper-1');
      form.append('language', opts.language || cfg.asrLanguage || 'zh');
      form.append('response_format', 'json');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.asrTimeoutMs || 60000);
      try {
        const headers = {};
        if (cfg.asrApiKey) headers.Authorization = `Bearer ${cfg.asrApiKey}`;
        const res = await fetch(endpoint, { method: 'POST', headers, body: form, signal: controller.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`语音识别服务返回 ${res.status}：${text.slice(0, 200)}`);
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`语音识别返回非 JSON：${text.slice(0, 200)}`);
        }
        const out = data.text || data.result || '';
        if (!out) throw new Error('语音识别结果为空，可能是录音太短或环境太吵');
        return out.trim();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function asrCapabilities(cfg) {
  if (cfg.asrProvider !== 'openai-compatible' || !cfg.asrBaseUrl) {
    return { provider: 'none', configured: false, label: '未配置语音识别（可用文字输入）' };
  }
  return {
    provider: 'openai-compatible',
    configured: true,
    model: cfg.asrModel || 'whisper-1',
    label: `语音识别 ${cfg.asrModel || 'whisper-1'}`,
  };
}
