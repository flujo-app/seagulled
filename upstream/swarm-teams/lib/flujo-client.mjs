// Minimal FLUJO HTTP client. Node built-ins only, so it runs on a bare worker image.
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request without Node fetch's 5-minute header timeout: flow runs can take hours. */
export function rawRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    if (timeoutMs > 0) request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    request.on('error', reject);
    request.end(payload);
  });
}

function parse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

export class FlujoClient {
  /** `token` is the worker control bearer; a local FLUJO in localhost mode needs none. */
  constructor({ origin, workspace, token }) {
    this.origin = origin.replace(/\/$/, '');
    this.workspace = workspace;
    this.token = token;
  }

  headers(workspace = this.workspace) {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(workspace ? { 'x-flujo-workspace': workspace } : {}),
    };
  }

  async api(method, path, body, { workspace = this.workspace, timeoutMs = 120_000 } = {}) {
    const url = new URL(this.origin + path);
    if (workspace) url.searchParams.set('workspace', workspace);
    const response = await rawRequest(url, { method, headers: this.headers(workspace), body, timeoutMs });
    return { status: response.status, body: parse(response.text) };
  }

  async expect(method, path, body, options) {
    const response = await this.api(method, path, body, options);
    if (response.status < 200 || response.status > 299) {
      const detail = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      throw new Error(`${method} ${path} failed (HTTP ${response.status}): ${detail.slice(0, 400)}`);
    }
    return response.body;
  }

  async workspaces() {
    return (await this.expect('GET', '/api/workspaces', undefined, { workspace: null })).workspaces.map((w) => w.name);
  }

  async ensureWorkspace(name = this.workspace) {
    if ((await this.workspaces()).includes(name)) return false;
    await this.expect('POST', '/api/workspaces', { name }, { workspace: null });
    // A workspace created over the API has no bundled MCP servers until first initialised.
    await this.api('GET', '/api/init', undefined, { workspace: name });
    return true;
  }

  /** Stop the workspace's MCP servers first: on Windows their open files block the delete. */
  async deleteWorkspace(name, { verificationDelayMs = 2000 } = {}) {
    for (const server of await this.servers().catch(() => [])) {
      await this.api('PUT', `/api/mcp/servers/${encodeURIComponent(server.name)}`, { name: server.name, disabled: true }, { workspace: name });
    }
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      last = await this.api('DELETE', '/api/workspaces', { name }, { workspace: null });
      if (last.status === 200) {
        // A successful deletion response can race an active background writer.
        // Only repeated exact-name absence is a cleanup receipt.
        const absent = !(await this.workspaces()).includes(name);
        await sleep(verificationDelayMs);
        if (absent && !(await this.workspaces()).includes(name)) return last.body;
      }
      await sleep(1500);
    }
    throw new Error(`Could not confirm deletion of workspace ${name} (HTTP ${last.status}).`);
  }

  async upsertModel(model) {
    const models = await this.expect('GET', '/api/model');
    const exists = Array.isArray(models) && models.some((entry) => entry.id === model.id);
    return this.expect(exists ? 'PUT' : 'POST', exists ? `/api/model/${model.id}` : '/api/model', model);
  }

  async servers() {
    const body = await this.expect('GET', '/api/mcp/servers');
    return Array.isArray(body) ? body : Object.values(body.servers ?? body);
  }

  async upsertServer(config) {
    const exists = (await this.servers()).some((server) => server.name === config.name);
    return this.expect(exists ? 'PUT' : 'POST',
      exists ? `/api/mcp/servers/${encodeURIComponent(config.name)}` : '/api/mcp/servers', config);
  }

  async flows() {
    const body = await this.expect('GET', '/api/flow');
    return Array.isArray(body) ? body : body.flows ?? [];
  }

  /** Compile and save a FlowSpec; an existing flow of the same name is replaced. */
  async saveFlowSpec(spec) {
    for (const flow of (await this.flows()).filter((entry) => entry.name === spec.name)) {
      await this.expect('DELETE', `/api/flow/${encodeURIComponent(flow.id)}`);
    }
    const result = await this.api('POST', '/api/flow/compile', { spec, save: true });
    if (result.status !== 201) {
      throw new Error(`Flow ${spec.name} did not compile cleanly (HTTP ${result.status}): ${JSON.stringify(result.body).slice(0, 1200)}`);
    }
    return result.body.flow;
  }

  async conversation(id) {
    return this.api('GET', `/v1/chat/conversations/${encodeURIComponent(id)}`);
  }

  async inject(id, content) {
    return this.expect('POST', `/v1/chat/conversations/${encodeURIComponent(id)}/inject`, { content, id: randomUUID() });
  }

  async cancel(id, timeoutMs = 5000) {
    return this.api('POST', `/v1/chat/conversations/${encodeURIComponent(id)}/cancel`, {}, { timeoutMs });
  }

  /**
   * Run a flow to completion. The conversation id is chosen up front, so a
   * dropped connection is recovered by reading that conversation, never by
   * sending the task a second time.
   */
  async runFlow({ flowName, prompt, conversationId = randomUUID(), timeoutMs = 6 * 3600_000, pollMs = 5000 }) {
    const body = {
      model: `flow-${flowName}`, stream: false,
      metadata: { flujo: 'true', requireApproval: 'false', conversationId },
      messages: [{ role: 'user', content: prompt }],
    };
    const deadline = Date.now() + timeoutMs;
    let transportError;
    try {
      const response = await rawRequest(`${this.origin}/v1/chat/completions?workspace=${encodeURIComponent(this.workspace)}`,
        { method: 'POST', headers: this.headers(), body, timeoutMs });
      const parsed = parse(response.text);
      if (response.status === 200 && parsed?.choices?.[0]?.message) {
        // A flow that ends on a handoff to Finish returns empty content; its answer is the last prose turn.
        let output = textOf(parsed.choices[0].message.content).trim();
        if (!output) output = lastAssistantText((await this.conversation(conversationId).catch(() => null))?.body?.messages);
        return { conversationId, status: 'completed', output };
      }
      if (response.status >= 400 && response.status < 500) {
        return { conversationId, status: 'failed', output: '', error: `HTTP ${response.status}: ${response.text.slice(0, 400)}` };
      }
      transportError = `HTTP ${response.status}`;
    } catch (error) {
      transportError = error.message;
    }
    while (Date.now() < deadline) {
      const read = await this.conversation(conversationId).catch(() => null);
      const status = read?.status === 200 ? read.body.status : undefined;
      if (status && !['running', 'queued', 'pending', 'awaiting'].includes(status)) {
        return { conversationId, status: status === 'completed' ? 'completed' : 'failed',
          output: lastAssistantText(read.body.messages), ...(status === 'completed' ? {} : { error: `conversation ${status}` }) };
      }
      if (read?.status === 404) return { conversationId, status: 'unknown', output: '', error: `conversation not found after submission; outcome is unconfirmed (${transportError})` };
      await sleep(pollMs);
    }
    return { conversationId, status: 'unknown', output: '', error: `no terminal state before the deadline (${transportError})` };
  }
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
}

export function lastAssistantText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.tool_calls?.length) continue;
    const text = textOf(message.content).trim();
    if (text) return text;
  }
  return '';
}
