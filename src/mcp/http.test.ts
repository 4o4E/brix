// MCP HTTP 集成测试：用官方 StreamableHTTPClientTransport 连接 /mcp，
// 验证 brix 暴露的是标准 Streamable HTTP MCP endpoint。

import { setupTestEnv, startTestServer, TEST_TOKEN } from '../server/test-helpers.js';

setupTestEnv('mcp-http');

import { after, before, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../server/http.js';

let started: { baseUrl: string; close: () => Promise<void> };

before(async () => {
  started = await startTestServer(createServer());
});

after(async () => {
  if (started) await started.close();
});

test('标准 Streamable HTTP MCP client 可连接 /mcp 并列出 tools', async () => {
  const client = new Client({ name: 'brix-http-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.baseUrl}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    },
  });

  await client.connect(transport);
  try {
    assert.ok(transport.sessionId, 'HTTP MCP 初始化后应返回 mcp-session-id');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 26);
    assert.ok(tools.some((t) => t.name === 'session_open'));
    assert.ok(tools.some((t) => t.name === 'browser_snapshot'));
    assert.ok(tools.some((t) => t.name === 'run_file_get'));
  } finally {
    await client.close();
  }
});
