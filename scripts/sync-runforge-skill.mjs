import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('用法：node scripts/sync-runforge-skill.mjs <RunForge 工作区>');
const root = resolve(checkout);
const plugin = resolve(root, 'plugins/business/brix');
const manifest = await readFile(resolve(plugin, 'runforge.plugin.yaml'), 'utf8');
if (!/^id: brix$/m.test(manifest)) throw new Error('目标缺少 RunForge Brix 插件');
const source = fileURLToPath(new URL('../skills/brix-browser/', import.meta.url));
for (const file of ['SKILL.md', 'scripts/cli.mjs', 'scripts/client.mjs', 'references/experience.md', 'references/local-scripts.md']) {
  const target = resolve(plugin, 'skills/brix-browser', file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(source, file), target);
}
