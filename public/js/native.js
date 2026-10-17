/**
 * 原生桥接与统一 HTTP 请求。
 *
 * 在 APK 里页面是 file:// 加载的，直接用 fetch 调第三方 API 会被 CORS 拦掉；
 * 因此优先走 Android 注入的 NativeHttp（Java 侧发请求再回调），
 * 浏览器里则回落到 fetch。
 */

/** 原生 NativeHttp 是否可用 */
export function hasNativeHttp() {
  try {
    return !!(window.NativeHttp && window.NativeHttp.available && window.NativeHttp.available());
  } catch {
    return false;
  }
}

/** 原生 AppBridge 是否可用（APK 内）—— 内部用 */
function hasNativeApp() {
  try {
    return !!(window.NativeApp && window.NativeApp.available && window.NativeApp.available());
  } catch {
    return false;
  }
}

/** APK 设置里保存的服务器地址（未设置返回空串） */
export function nativeServerUrl() {
  try {
    return hasNativeApp() ? String(window.NativeApp.getServerUrl() || '') : '';
  } catch {
    return '';
  }
}

export function nativeAppVersion() {
  try {
    return hasNativeApp() ? String(window.NativeApp.appVersion() || '') : '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * base64（原生桥只能传字符串）
 * ------------------------------------------------------------------ */

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(String(b64 || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * 统一请求
 * ------------------------------------------------------------------ */

let nativeSeq = 0;
const nativePending = new Map();

// 原生回调入口，必须在页面加载时挂上
if (typeof window !== 'undefined') {
  window.__nativeHttp = function onNativeHttp(id, resultJson) {
    const pending = nativePending.get(id);
    if (!pending) return;
    nativePending.delete(id);
    let parsed;
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      pending.reject(new Error('原生请求返回了无法解析的结果'));
      return;
    }
    if (parsed.error) pending.reject(new Error(String(parsed.error)));
    else pending.resolve(parsed);
  };
}

function nativeRequest({ method, url, headers, bodyBytes }) {
  return new Promise((resolve, reject) => {
    const id = `n${Date.now().toString(36)}_${(nativeSeq += 1)}`;
    nativePending.set(id, { resolve, reject });
    setTimeout(() => {
      if (nativePending.has(id)) {
        nativePending.delete(id);
        reject(new Error('原生请求超时'));
      }
    }, 130000);
    try {
      window.NativeHttp.request(
        id,
        method,
        url,
        JSON.stringify(headers || {}),
        bodyBytes && bodyBytes.length ? bytesToBase64(bodyBytes) : '',
      );
    } catch (err) {
      nativePending.delete(id);
      reject(err);
    }
  });
}

/**
 * 统一 HTTP 请求。
 * @param {{method?:string, url:string, headers?:Record<string,string>, body?:string|Uint8Array|null, timeoutMs?:number}} opts
 * @returns {Promise<{status:number, headers:Record<string,string>, text:string, bytes:Uint8Array}>}
 */
export async function httpRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = 120000 }) {
  const bodyBytes = body == null
    ? null
    : (typeof body === 'string' ? new TextEncoder().encode(body) : body);

  if (hasNativeHttp()) {
    const res = await nativeRequest({ method, url, headers, bodyBytes });
    const bytes = res.body ? base64ToBytes(res.body) : new Uint8Array(0);
    return {
      status: res.status || 0,
      headers: res.headers || {},
      bytes,
      text: new TextDecoder().decode(bytes),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = { method, headers, signal: controller.signal };
    if (bodyBytes) init.body = bodyBytes;
    const res = await fetch(url, init);
    const buf = new Uint8Array(await res.arrayBuffer());
    const outHeaders = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { status: res.status, headers: outHeaders, bytes: buf, text: new TextDecoder().decode(buf) };
  } finally {
    clearTimeout(timer);
  }
}

/** 请求并解析 JSON，非 2xx 抛错 */
export async function httpJson(opts) {
  const res = await httpRequest(opts);
  let data = null;
  try {
    data = res.text ? JSON.parse(res.text) : null;
  } catch {
    throw new Error(`服务器返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error((data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

/** 手动拼 multipart（用于把录音 POST 给 OpenAI 兼容的语音识别接口） */
export function buildMultipart(fields, file) {
  const boundary = `----keepaccounts${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const chunks = [];
  for (const [k, v] of Object.entries(fields || {})) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`,
  ));
  chunks.push(file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes));
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return { body: out, contentType: `multipart/form-data; boundary=${boundary}` };
}
