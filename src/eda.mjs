import { execFile } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { projectName } from './design.mjs';

const run = promisify(execFile);
let located;
export async function kiCadBinary() {
  if (process.env.PCB_KICAD_CLI) return process.env.PCB_KICAD_CLI;
  if (process.platform !== 'win32') return 'kicad-cli';
  located ??= (async () => {
    try { return (await run('where.exe', ['kicad-cli.exe'], { windowsHide: true })).stdout.trim().split(/\r?\n/)[0]; }
    catch {
      const root = join(process.env.ProgramFiles || 'C:/Program Files', 'KiCad');
      const versions = await readdir(root).catch(() => []);
      const candidates = [...versions.sort().reverse().map(version => join(root, version, 'bin/kicad-cli.exe')), 'D:/PCB/bin/kicad-cli.exe'];
      for (const file of candidates) {
        try { await access(file); return file; } catch { /* Try the next installed location. */ }
      }
      throw new Error('没有找到 KiCad。请安装 KiCad 9 或设置 PCB_KICAD_CLI。');
    }
  })();
  return located;
}

export async function runKiCad(args) {
  return run(await kiCadBinary(), args, { windowsHide: true, timeout: 30000, maxBuffer: 512 * 1024 });
}

export async function renderKiCad(directory, hasBoard, schematicChanged = true) {
  const previews = join(directory, 'preview');
  await mkdir(previews, { recursive: true });
  const jobs = schematicChanged ? [runKiCad(['sch', 'export', 'svg', '--exclude-drawing-sheet', '--no-background-color', '-o', previews, join(directory, `${projectName}.kicad_sch`)])] : [];
  if (hasBoard) {
    for (const [name, layers] of [['front', 'F.Cu,Edge.Cuts'], ['back', 'B.Cu'], ['silk', 'F.SilkS']]) {
      jobs.push(runKiCad(['pcb', 'export', 'svg', '--mode-single', '--layers', layers, '--page-size-mode', '1', '--exclude-drawing-sheet', '-o', join(previews, `${name}.svg`), join(directory, `${projectName}.kicad_pcb`)]));
    }
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
