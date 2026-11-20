// 业务命令保留各自的参数和结果，HTTP 传输走通用 CLI 客户端。
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getEnv } from '../config.js';
import { clientFromEnv } from '../../skills/brix-browser/scripts/client.mjs';

interface CliOpts {
  out?: string;
  url?: string;
}

interface CliResult {
  runId: string;
  output: unknown;
  savedFiles: string[];
}

export async function pushScript(name: string, source: string, language: 'js' | 'ts'): Promise<unknown> {
  getEnv();
  return clientFromEnv().put(name, source, language);
}

export async function runViaBrix(scriptName: string, args: unknown, opts: CliOpts = {}): Promise<CliResult> {
  getEnv();
  const client = clientFromEnv();
  return client.inSession(undefined, async (sessionId) => {
    const { runId, output, downloads } = await client.run(sessionId, scriptName, args);
    const dir = opts.out ?? join('out', runId);
    await mkdir(dir, { recursive: true });
    const savedFiles: string[] = [];
    for (const { name } of downloads) {
      const path = join(dir, name);
      await client.download(runId, name, path);
      savedFiles.push(path);
    }
    return { runId, output, savedFiles };
  }, opts.url);
}
