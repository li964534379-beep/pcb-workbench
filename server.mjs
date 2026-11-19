import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boardProfile, projectName } from './src/design.mjs';
import { defaultModelSettings } from './src/model.mjs';
import { ModelSettings } from './src/model-settings.mjs';
import { ProjectStore } from './src/projects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/app.css', ['app.css', 'text/css']]]);

async function body(request, maximum) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new Error('上传内容过大，首版工程压缩包不能超过 16 MB。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createWorkbench({ dataDirectory = resolve(process.env.PCB_WORKBENCH_DATA || join(here, 'data')), model = defaultModelSettings() } = {}) {
  const settings = new ModelSettings(model);
  const store = new ProjectStore(dataDirectory, selection => settings.resolve(selection));
  await store.initialize();
  const server = createServer(async (request, response) => {
    const send = (status, value, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
        send(403, { error: '请在本机工作台页面操作。' }); return;
      }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        send(200, await readFile(join(here, 'public', file)), type); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        send(200, { projects: await store.list(), settings: settings.public(), capability: boardProfile }); return;
      }
      const match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/(chat|resistance|confirm|explain|export|preview))?$/);
      if (request.method === 'GET' && match) {
        const [, id, action] = match;
        if (action === 'export') {
          const archive = await store.exportArchive(id, Number(url.searchParams.get('revision')));
          response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${projectName}-r${url.searchParams.get('revision')}.zip"`, 'Cache-Control': 'no-store' });
          response.end(archive); return;
        }
        if (action === 'preview') {
          const project = await store.load(id);
          const revision = Number(url.searchParams.get('revision'));
          const kind = url.searchParams.get('kind');
          const names = { schematic: `${projectName}.svg`, front: 'front.svg', back: 'back.svg', silk: 'silk.svg' };
          if (!names[kind] || !Number.isInteger(revision) || revision < 1 || revision > project.revision) throw new Error('预览版本或类型不存在。');
          send(200, await readFile(join(store.revisionDirectory(project, revision), 'preview', names[kind])), 'image/svg+xml'); return;
        }
        if (!action) { send(200, await store.load(id)); return; }
      }
      if (request.method !== 'POST') { send(404, { error: '没有这个操作。' }); return; }
      if (url.pathname === '/api/import') {
        if (request.headers['content-type'] !== 'application/zip') throw new Error('请上传 KiCad 工程 ZIP。');
        send(200, await store.importArchive(await body(request, 16 * 1024 * 1024), url.searchParams.get('name') || 'project.zip')); return;
      }
      if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请求需要使用 JSON 格式。');
      const payload = JSON.parse((await body(request, 48 * 1024)).toString('utf8'));
      if (url.pathname === '/api/settings') {
        send(200, settings.update(payload)); return;
      }
      if (url.pathname === '/api/models') { send(200, await settings.refresh(payload.connectionId)); return; }
      if (url.pathname === '/api/projects') { send(200, await store.create()); return; }
      if (match && Number.isInteger(payload.revision)) {
        const [, id, action] = match;
        if (action === 'chat') { send(200, await store.discuss(id, payload.revision, payload.text, payload.modelSelection)); return; }
        if (action === 'resistance') { send(200, await store.setResistance(id, payload.revision, payload.resistance)); return; }
        if (action === 'confirm') { send(200, await store.confirm(id, payload.revision, payload.proposalId)); return; }
        if (action === 'explain') { send(200, await store.explain(id, payload.revision, payload.modelSelection)); return; }
      }
      send(404, { error: '没有这个操作。' });
    } catch (error) {
      if (error.code === 'ENOENT') send(404, { error: '工程或文件不存在。' });
      else if (error instanceof SyntaxError) send(400, { error: '文件或请求格式无法读取。' });
      else if (error.cmd) send(422, { error: 'KiCad 处理没有完成，请检查工程格式及 KiCad 安装。' });
      else send(422, { error: error.message || '操作没有完成。' });
    }
  });
  server.requestTimeout = 150000;
  return { server, store };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { server } = await createWorkbench();
  const port = Number(process.env.PCB_PORT || 3210);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 正在使用。可设置 PCB_PORT 更换端口。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`PCB 工作台：http://127.0.0.1:${server.address().port}`));
}
