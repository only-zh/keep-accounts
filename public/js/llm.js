/**
 * 前端侧的大模型 / 语音识别适配器。
 * 用于「本地模式」（APK 未连服务器时）：Key 存在手机设置里，直连 DeepSeek。
 * 服务器模式下这些能力由服务端提供，Key 不下发到前端。
 */

import { httpRequest, buildMultipart } from './native.js';

/**
 * 语音识别：
 * - 服务器模式：POST {server}/api/asr（服务端持有 Key）
 * - 本地模式：直连 OpenAI 兼容的 /audio/transcriptions（手机上的 Key）
 * @param {{ mode:'remote', serverUrl?:string, token?:string, provider?:string,
 *           apiKey?:string, baseUrl?:string, model?:string, language?:string }} cfg
 */
export async function transcribe(blob, mime, cfg = {}) {
  if (cfg.mode === 'remote') {
    const base = String(cfg.serverUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('没有配置服务器地址');
    const headers = { 'Content-Type': mime || 'audio/webm' };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const res = await httpRequest({ method: 'POST', url: `${base}/api/asr`, headers, body: bytes, timeoutMs: 90000 });
    let data = null;
    try { data = JSON.parse(res.text); } catch { /* ignore */ }
    if (res.status < 200 || res.status >= 300) {
      const msg = (data && data.error) || `语音识别失败（HTTP ${res.status}）`;
      const err = new Error(msg);
      err.code = data && data.code;
      throw err;
    }
    return data.data.text;
  }

  // 本地模式
  const provider = String(cfg.provider || 'none').toLowerCase();
  if (provider !== 'openai-compatible' || !cfg.baseUrl) {
    const err = new Error('还没有配置语音识别，可以在设置里填写，或改用文字输入');
    err.code = 'ASR_NOT_CONFIGURED';
    throw err;
  }
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const endpoint = /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ext = (mime || '').includes('mp4') ? 'm4a' : (mime || '').includes('ogg') ? 'ogg' : 'webm';
  const { body, contentType } = buildMultipart(
    { model: cfg.model || 'whisper-1', language: cfg.language || 'zh', response_format: 'json' },
    { filename: `audio.${ext}`, type: mime || 'audio/webm', bytes },
  );
  const headers = { 'Content-Type': contentType };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await httpRequest({ method: 'POST', url: endpoint, headers, body, timeoutMs: 90000 });
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* ignore */ }
  if (res.status < 200 || res.status >= 300) {
    throw new Error((data && (data.error?.message || data.error)) || `语音识别失败（HTTP ${res.status}）`);
  }
  const text = (data && (data.text || data.result)) || '';
  if (!text.trim()) throw new Error('没听清，再说一次试试');
  return text.trim();
}

