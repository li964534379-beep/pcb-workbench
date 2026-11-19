import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const usage = '工作台 CLI（先运行 npm start）\n  node cli.mjs app projects\n  node cli.mjs app new\n  node cli.mjs app open <工程ID>\n  node cli.mjs app chat <工程ID> "需求或修改"\n  node cli.mjs app set-r1 <工程ID> <整数欧姆值>\n  node cli.mjs app confirm <工程ID> <版本号> <提案ID或schematic> --confirm\n  node cli.mjs app import <工程.zip>\n  node cli.mjs app export <工程ID> <新文件.zip>';

export async function workbenchClient(args) {
  const [command, input, argument, proposalId, confirmed, ...extra] = args;
  const baseUrl = (process.env.PCB_WORKBENCH_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
  async function request(path, payload, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, payload === undefined ? options : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error((await response.json()).error);
    return response;
  }
  const open = id => request(`/api/projects/${encodeURIComponent(id)}`).then(response => response.json());
  if (extra.length) throw new Error(usage);
  if (command === 'projects' && !input) return (await (await request('/api/bootstrap')).json()).projects;
  if (command === 'new' && !input) return (await request('/api/projects', {})).json();
  if (command === 'open' && input && !argument) return open(input);
  if (command === 'chat' && input && argument && !proposalId) {
    const project = await open(input);
    return (await request(`/api/projects/${project.id}/chat`, { revision: project.revision, text: argument })).json();
  }
  if (command === 'set-r1' && input && /^\d+$/.test(argument) && !proposalId) {
    const project = await open(input);
    return (await request(`/api/projects/${project.id}/resistance`, { revision: project.revision, resistance: Number(argument) })).json();
  }
  if (command === 'confirm' && input && /^\d+$/.test(argument) && proposalId && confirmed === '--confirm') {
    return (await request(`/api/projects/${encodeURIComponent(input)}/confirm`, { revision: Number(argument), proposalId })).json();
  }
  if (command === 'import' && input && !argument) return (await request(`/api/import?name=${encodeURIComponent(basename(input))}`, undefined, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await readFile(input) })).json();
  if (command === 'export' && input && argument && !proposalId) {
    const project = await open(input);
    const bytes = new Uint8Array(await (await request(`/api/projects/${project.id}/export?revision=${project.revision}`)).arrayBuffer());
    await writeFile(argument, bytes, { flag: 'wx' });
    return { file: argument, revision: project.revision, bytes: bytes.length };
  }
  throw new Error(usage);
}
