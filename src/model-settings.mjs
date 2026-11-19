import { randomUUID } from 'node:crypto';

function modelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('请填写有效的模型名称。');
  return value.trim();
}

function baseAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写有效的 API 基础地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 基础地址只支持不带账号、查询参数的 HTTP 或 HTTPS 地址。');
  const address = url.href.replace(/\/+$/, '');
  if (/\/(chat\/completions|models)$/.test(address)) throw new Error('这里只填写 API 基础地址，例如 https://example.com/v1，不包含 /chat/completions 或 /models。');
  return address;
}

export class ModelSettings {
  constructor(initial) {
    this.current = { provider: initial.provider, baseUrl: initial.baseUrl ? baseAddress(initial.baseUrl) : '', model: typeof initial.model === 'string' ? initial.model.trim() : '', apiKey: initial.apiKey || '' };
    this.models = [];
    this.connectionId = randomUUID();
  }

  public() {
    const { provider, baseUrl, model, apiKey } = this.current;
    return { provider, baseUrl, model, hasApiKey: !!apiKey, apiConfigured: !!baseUrl, connectionId: this.connectionId, models: [...new Set([model, ...this.models].filter(Boolean))] };
  }

  update(payload) {
    if (payload.provider === 'codex') {
      // Switching execution mode retains the configured API connection in memory.
      this.current = { ...this.current, provider: 'codex' };
    } else if (payload.provider === 'api') {
      const baseUrl = baseAddress(payload.baseUrl);
      const model = payload.model === '' || payload.model === undefined ? '' : modelName(payload.model);
      if ((payload.apiKey !== undefined && typeof payload.apiKey !== 'string') || (payload.clearApiKey !== undefined && typeof payload.clearApiKey !== 'boolean')) throw new Error('API Key 设置格式不正确。');
      if (payload.clearApiKey && payload.apiKey) throw new Error('清除旧密钥和填写新密钥请选择一种操作。');
      const apiKey = payload.clearApiKey ? '' : payload.apiKey ?? (baseUrl === this.current.baseUrl ? this.current.apiKey : '');
      if (baseUrl !== this.current.baseUrl || apiKey !== this.current.apiKey) this.models = [];
      this.current = { provider: 'api', baseUrl, model, apiKey };
    } else throw new Error('请选择本机 Codex 或自定义 API。');
    this.connectionId = randomUUID();
    return this.public();
  }

  resolve(selection) {
    if (!selection) return { ...this.current };
    if (selection.connectionId !== this.connectionId) throw new Error('模型连接设置已变化，请刷新页面后重新选择模型。');
    if (selection.provider === 'codex') return { provider: 'codex' };
    if (selection.provider !== 'api' || !this.current.baseUrl) throw new Error('请先在模型设置中配置 API 连接。');
    return { ...this.current, provider: 'api', model: modelName(selection.model) };
  }

  async refresh(connectionId) {
    if (connectionId !== this.connectionId) throw new Error('模型连接设置已变化，请刷新页面。');
    const { baseUrl, apiKey } = this.current;
    if (!baseUrl) throw new Error('请先配置 API 基础地址，再获取模型列表。');
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    let response;
    try { response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('无法获取模型列表，仍可在模型设置里手动填写模型名称。'); }
    if (!response.ok) throw new Error(`获取模型列表返回 HTTP ${response.status}，仍可手动填写模型名称。`);
    let data;
    try { data = await response.json(); } catch { throw new Error('模型列表不是可读取的 JSON，仍可手动填写模型名称。'); }
    if (!Array.isArray(data?.data)) throw new Error('接口没有返回 data 模型列表，仍可手动填写模型名称。');
    if (connectionId !== this.connectionId) throw new Error('获取期间模型连接已变化，请重新获取。');
    this.models = [...new Set(data.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 256).map(id => id.trim()))].sort();
    return this.public();
  }
}
