// MCP over HTTP：把 brix 的 MCP tools 挂到现有 HTTP 服务的 /mcp。
//
// 使用 MCP Streamable HTTP（标准远程 transport）：客户端 POST initialize 后拿到
// mcp-session-id，后续 GET/POST/DELETE 都带该 session id 复用同一个 transport。

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../../mcp/server.js';
import { createLogger } from '../../utils/logger.js';
import { readJson, sendJson } from '../util.js';

const log = createLogger('routes-mcp');

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof buildServer>;
}

const sessions = new Map<string, McpSession>();

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function sendMcpError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

export async function closeMcpTransports(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(entries.map(async ({ transport, server }) => {
    await transport.close().catch(() => { /* ignore */ });
    await server.close().catch(() => { /* ignore */ });
  }));
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/mcp') return false;

  const method = req.method ?? 'GET';
  let body: unknown;
  if (method === 'POST') {
    try {
      body = await readJson(req);
    } catch (e) {
      sendMcpError(res, 400, -32700, e instanceof Error ? e.message : String(e));
      return true;
    }
  }

  const sessionId = headerValue(req.headers['mcp-session-id']);
  let entry = sessionId ? sessions.get(sessionId) : undefined;

  if (!entry) {
    if (sessionId) {
      sendMcpError(res, 404, -32000, 'MCP session not found');
      return true;
    }
    if (method !== 'POST' || !isInitializeRequest(body)) {
      sendMcpError(res, 400, -32000, 'MCP initialize request required');
      return true;
    }

    const server = buildServer();
    let initializedSessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        initializedSessionId = sid;
        sessions.set(sid, { transport, server });
        log.info(`MCP session initialized ${sid}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId ?? initializedSessionId;
      if (sid) sessions.delete(sid);
      void server.close().catch(() => { /* ignore */ });
      log.info(`MCP session closed ${sid ?? '<unknown>'}`);
    };

    await server.connect(transport);
    entry = { transport, server };
  }

  try {
    await entry.transport.handleRequest(req, res, body);
  } catch (e) {
    log.error(`MCP request failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
    if (!res.headersSent) sendMcpError(res, 500, -32603, 'Internal MCP error');
  }
  return true;
}
