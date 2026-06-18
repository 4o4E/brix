// brix-mcp 入口：stdio MCP server，把 brix 浏览器原语暴露给 LLM 客户端（Claude 等）。
//
// 用法（在 MCP 客户端配置里）：command = npx/tsx，args = ["tsx","scripts/mcp.ts"]，
// env 复用 brix：BRIX_TOKEN 必填；BRIX_API_URL 可指远端 brix，否则按 HTTP_HOST/PORT 推导本机。
//
// 注意：本进程只经 HTTP 调 brix，不自己拉 Chrome —— 需先 `npm run serve` 起 brix。
// stdio 传输：日志只能走 stderr（stdout 是协议通道），所以这里用 console.error。

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getEnv } from '../src/config.js';
import { buildServer } from '../src/mcp/server.js';

async function main(): Promise<void> {
  if (!getEnv().HTTP_TOKEN) {
    console.error('ERROR: BRIX_TOKEN env required (brix MCP server talks to brix over HTTP)');
    process.exit(1);
  }
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error('brix-mcp running on stdio');
}

main().catch((e) => {
  console.error('brix-mcp fatal:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
