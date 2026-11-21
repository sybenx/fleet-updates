// A thin MCP client for umbrelOS: streamable HTTP, JSON-RPC 2.0. One session per use:
// initialize, notifications/initialized, then tools/call. Responses may come back as plain JSON
// or as a text/event-stream with the JSON-RPC message in a `data:` line; both are handled.
//
// The token goes in the Authorization header only. Errors never include it.

const PROTOCOL = '2025-06-18';

export class McpError extends Error {}

function parseBody(text, contentType, id) {
  let messages = [];
  if (/text\/event-stream/i.test(contentType || '')) {
    let data = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (line === '' && data.length) {
        messages.push(data.join('\n'));
        data = [];
      }
    }
    if (data.length) messages.push(data.join('\n'));
  } else if (text.trim()) messages = [text];
  for (const m of messages) {
    let j;
    try {
      j = JSON.parse(m);
    } catch {
      continue;
    }
    for (const msg of Array.isArray(j) ? j : [j]) if (msg && msg.id === id) return msg;
  }
  throw new McpError('no reply from the Umbrel');
}

// The tool's result: structuredContent when the server sends it, else the JSON in the first text
// block, else that text.
export function toolResult(result) {
  if (!result) return null;
  if (result.isError) {
    const t = (result.content || []).find((c) => c.type === 'text');
    throw new McpError(t ? t.text.slice(0, 300) : 'tool failed');
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const t = (result.content || []).find((c) => c.type === 'text');
  if (!t) return null;
  try {
    return JSON.parse(t.text);
  } catch {
    return t.text;
  }
}

export async function openSession(url, token, { fetch: f = fetch, timeoutMs = 30000 } = {}) {
  let sessionId = null;
  let nextId = 1;

  async function post(body) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': PROTOCOL,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    let res;
    try {
      res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new McpError(e.name === 'TimeoutError' ? 'timed out' : 'not reachable');
    }
    if (res.status === 401 || res.status === 403) throw new McpError('token refused');
    if (!res.ok && res.status !== 202) throw new McpError(`HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return res;
  }

  async function request(method, params) {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    const msg = parseBody(await res.text(), res.headers.get('content-type'), id);
    if (msg.error) throw new McpError(String(msg.error.message || 'error').slice(0, 300));
    return msg.result;
  }

  await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'fleet-updates', version: '0.1.0' } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    async call(name, args = {}) {
      return toolResult(await request('tools/call', { name, arguments: args }));
    },
  };
}
