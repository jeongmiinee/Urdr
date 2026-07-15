import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(process.cwd());
const source = path.join(root, 'vendor', 'mapgen4');
const output = path.join(root, 'public', 'mapgen4');
const buildDir = path.join(output, 'build');
await rm(output, {recursive: true, force: true});
await mkdir(buildDir, {recursive: true});

const generatorFile = path.join(buildDir, '_generate-points-file.mjs');
await build({
  entryPoints: [path.join(source, 'generate-points-file.ts')],
  bundle: true,
  preserveSymlinks: true,
  platform: 'node',
  format: 'esm',
  outfile: generatorFile,
});
const pointBuild = spawnSync(process.execPath, [generatorFile], {cwd: output, stdio: 'inherit'});
if (pointBuild.status !== 0) throw new Error('Mapgen4 point data generation failed');
await rm(generatorFile, {force: true});
await build({
  entryPoints: [path.join(source, 'mapgen4.ts')],
  bundle: true,
  preserveSymlinks: true,
  minify: true,
  sourcemap: true,
  outfile: path.join(buildDir, '_bundle.js'),
});
await build({
  entryPoints: [path.join(source, 'worker.ts')],
  bundle: true,
  preserveSymlinks: true,
  minify: true,
  sourcemap: true,
  outfile: path.join(buildDir, '_worker.js'),
});

const embed = await readFile(path.join(source, 'embed.html'), 'utf8');
const body = embed.replace('<div style="width:auto">', '<div class="mapgen4-root">');
const html = `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>World Archive 자유 모드 · Mapgen4</title>
<style>
:root{color-scheme:dark;--sans-serif:Pretendard,"Noto Sans KR",Arial,sans-serif;--monospace:"Cascadia Mono",monospace}
html,body{width:100%;height:100%;overflow:hidden;background:#0b111b;color:#e8eef8}
.mapgen4-header{height:58px;box-sizing:border-box;display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid #26344a;background:#101827;font-family:var(--sans-serif)}
.mapgen4-header strong{font-size:16px}.mapgen4-header span{font-size:12px;color:#9fb0c8}.mode-pill{border-radius:999px;background:#1c6f5b;padding:5px 9px;font-size:11px!important;color:#eafff8!important}.mapgen4-spacer{flex:1}.mapgen4-header button{border:1px solid #40516b;background:#18243a;color:#eef5ff;border-radius:7px;padding:7px 11px;font-weight:700}
.mapgen4-shell{height:calc(100% - 58px);overflow:auto;background:#f6f4ea;color:#171717}.mapgen4-shell>div{min-height:100%}
</style></head><body><header class="mapgen4-header"><span class="mode-pill">자유 모드</span><strong>Red Blob Games Mapgen4</strong><span>산·계곡·바다를 직접 칠하면 고도·강우·하천이 독립적으로 재계산됩니다.</span><span class="mapgen4-spacer"></span><button id="button-download" type="button">PNG 저장</button></header><main class="mapgen4-shell">${body}</main></body></html>`;
await writeFile(path.join(output, 'index.html'), html);
await copyFile(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-Mapgen4.txt'));
console.log(`Mapgen4 built into ${output}`);
