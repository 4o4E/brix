// 雪花式短 ID：高 48 bits ms 时间戳（自 2024-01-01）+ 低 16 bits 进程内 ms-sequence。
// base62 编码定长 11 字符；外层再拼上 local 日期前缀，形如 "2026-05-25-8KqL2nQrM5x"。
//
// 日期用 local 时区而不是 UTC：用户在本机 ls data/runs/ 想看到"今天"等于 wall-clock
// 今天，UTC 边界会让北京时间凌晨 8 点之前跑的脚本被分到前一天。
//
// 16 bits seq → 单 ms 最多 65536 个 ID；溢出时 busy-wait 到下一 ms。

const EPOCH = Date.UTC(2024, 0, 1);
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;
const ID_LEN = 11;

let lastMs = 0;
let seq = 0;

function encodeBase62(n: bigint): string {
  if (n === 0n) return ALPHABET[0].repeat(ID_LEN);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % BASE)] + s;
    n /= BASE;
  }
  return s.length >= ID_LEN ? s : ALPHABET[0].repeat(ID_LEN - s.length) + s;
}

function localDatePrefix(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function nextId(): string {
  let now = Date.now();
  if (now === lastMs) {
    seq++;
    if (seq > 0xffff) {
      while (Date.now() === lastMs) { /* busy-wait <1ms */ }
      now = Date.now();
      lastMs = now;
      seq = 0;
    }
  } else {
    lastMs = now;
    seq = 0;
  }
  const ts = BigInt(now - EPOCH);
  const combined = (ts << 16n) | BigInt(seq);
  return `${localDatePrefix(now)}-${encodeBase62(combined)}`;
}
