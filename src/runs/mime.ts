// 文件名/runId 校验 + 扩展名 → mime 小表
//
// 设计取舍：
// - 不引第三方 mime 库（依赖最小）；表里只列常见浏览器下载类型，其他统一 octet-stream
// - sanitizeName 用 deny-list 思路：先按白名单正则筛掉所有"不像文件名"的输入，再单独排除 `.` 开头

import { extname } from 'node:path';

const MIME_TABLE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeOf(filename: string): string {
  return MIME_TABLE[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

const NAME_RE = /^[A-Za-z0-9._-]{1,255}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.startsWith('.') && !name.includes('..');
}

export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id) && !id.startsWith('.') && !id.includes('..');
}

export function isValidScriptName(name: string): boolean {
  return SCRIPT_NAME_RE.test(name);
}

/** 把任意候选名规范成安全文件名；非法字符替换成 _，仍非法则返回 fallback */
export function sanitizeName(candidate: string, fallback: string): string {
  const cleaned = candidate
    .replace(/[\\/]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 255);
  return isValidName(cleaned) ? cleaned : fallback;
}
