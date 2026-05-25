// 启动期把 built-in-scripts/*.ts 拷到 SCRIPTS_DIR —— 缺啥拷啥，不覆盖。
//
// 用户对 data/scripts/<name>.ts 的运行时改动（HTTP PUT 或手改）在 server 重启后
// 保留；想恢复内置模板就手动 `rm data/scripts/<name>.ts` 再重启。
//
// 失败语义：BUILTIN_SCRIPTS_DIR 读不到（如 repo 内没装这个目录）→ 不抛，返回
// 空结果。调用方（serve.ts）拿到空 copied/skipped 自己决定要不要 warn。

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getEnv } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bootstrap');

export interface SyncResult {
  copied: string[];
  skipped: string[];
}

export async function syncBuiltins(): Promise<SyncResult> {
  const env = getEnv();
  await mkdir(env.SCRIPTS_DIR, { recursive: true });

  let entries: string[];
  try {
    entries = await readdir(env.BUILTIN_SCRIPTS_DIR);
  } catch (e) {
    log.warn(`builtins dir not readable (${env.BUILTIN_SCRIPTS_DIR}): ${e instanceof Error ? e.message : e}`);
    return { copied: [], skipped: [] };
  }

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const f of entries) {
    if (!f.endsWith('.ts')) continue;
    const dst = join(env.SCRIPTS_DIR, f);
    try {
      await stat(dst);
      skipped.push(f);
      continue;
    } catch { /* dst missing → copy */ }
    try {
      await copyFile(join(env.BUILTIN_SCRIPTS_DIR, f), dst);
      copied.push(f);
    } catch (e) {
      log.warn(`copy ${f} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  log.info(`builtins synced: copied=${copied.length} skipped=${skipped.length}`);
  return { copied, skipped };
}
