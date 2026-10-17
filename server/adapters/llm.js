/**
 * 大模型适配器（OpenAI 兼容 /chat/completions，默认 DeepSeek）。
 * - provider = deepseek：真实调用
 * - provider = mock：演示模型，用本地规则产出与模型完全相同的 JSON 结构（无 Key 时保证全链路可用）
 * - 未配置：返回 null，由调用方走规则兜底
 */

/**
 * @param {ReturnType<import('../config.js').loadConfig>} cfg
 * @returns {null | ((messages:any[], opts?:any)=>Promise<string>)}
 */
export function createLLM(cfg) {
  const provider = cfg.llmProvider;
  if (provider === 'none') return null;
  if (provider === 'mock' || (provider === 'auto' && !cfg.deepseekApiKey)) {
    const mock = createMockLLM();
    return mock;
  }
  if (!cfg.deepseekApiKey) return null;

  return async function callDeepSeek(messages, opts = {}) {
    const url = `${String(cfg.deepseekBaseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs || 45000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.deepseekModel || 'deepseek-chat',
          messages,
          temperature: 0.1,
          max_tokens: 1500,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`DeepSeek 返回 ${res.status}：${text.slice(0, 300)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`DeepSeek 返回非 JSON：${text.slice(0, 200)}`);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek 返回内容为空');
      return content;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 演示模型：结构与真实模型一致，便于没有 Key 时联调与回归测试 */
export function createMockLLM() {
  return async function mockLLM(messages, opts = {}) {
    const { fallbackParse, makeCtx } = await import('../../shared/parse-core.js');
    const ctx = opts.ctx || makeCtx({});
    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    const text = userMsg ? userMsg.content : '';
    const res = fallbackParse(text, ctx);
    return JSON.stringify({
      intent: res.intent,
      records: (res.records || []).map((r) => ({
        type: r.type,
        amount: r.amountCents / 100,
        category: r.category,
        subcategory: r.subcategory,
        date_iso: r.occurredDate,
        time_iso: r.occurredTime,
        date_text: r.occurredText,
        merchant: r.merchant,
        note: r.note,
        payer: r.payerName,
        participants: (r.participants || []).map((p) => p.name),
        split: (r.participants || []).length > 1 ? 'equal' : 'none',
        confidence: r.confidence,
      })),
      query: res.query,
      clarification: res.clarification,
    });
  };
}

/** 对外暴露的能力信息（前端据此提示用户） */
export function llmCapabilities(cfg) {
  if (cfg.llmProvider === 'none') {
    return { provider: 'none', configured: false, model: null, label: '未启用大模型（本地规则识别）' };
  }
  if (cfg.llmProvider === 'mock' || (cfg.llmProvider === 'auto' && !cfg.deepseekApiKey)) {
    return { provider: 'mock', configured: false, model: 'mock', label: '演示解析（服务端未配置模型 Key）' };
  }
  return {
    provider: 'deepseek',
    configured: true,
    model: cfg.deepseekModel || 'deepseek-chat',
    label: `DeepSeek ${cfg.deepseekModel || 'deepseek-chat'}`,
  };
}
