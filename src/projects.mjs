import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { boardProfile, designFor, projectName } from './design.mjs';
import { renderKiCad } from './eda.mjs';
import { inspectKiCad, readResistance, resistanceNumber, reviseKiCad } from './kicad.mjs';
import { buildConfirmedSchematic, discussDesign, explainKiCadReports, proposeKiCadEdit, recordCheckedSchematic, resistorChange, routeConfirmedSchematic, verifyBoard, verifySchematic } from './workflow.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const archivedFile = name => !name.endsWith('/') && !name.split('/').some(part => ['preview', 'node_modules', '.git', '__MACOSX'].includes(part)) && !['workflow.json', 'erc.json', 'drc.json'].includes(posix.basename(name)) && !/\.(?:bak|lck|kicad_prl)$/.test(name);

export class ProjectStore {
  constructor(root, modelSettings) {
    this.root = root;
    this.modelSettings = modelSettings;
    this.busy = new Set();
  }

  directory(id) {
    if (!uuidPattern.test(id)) throw new Error('工程编号无效。');
    return join(this.root, id);
  }

  async initialize() { await mkdir(this.root, { recursive: true }); }
  async load(id) { return json(join(this.directory(id), 'project.json')); }
  revisionDirectory(project, revision = project.revision) {
    const artifact = project.history.find(entry => entry.revision === revision)?.artifact;
    return join(this.directory(project.id), 'revisions', artifact || String(revision));
  }

  async save(project) {
    project.updatedAt = new Date().toISOString();
    const file = join(this.directory(project.id), 'project.json');
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(project, null, 2));
    await rename(temporary, file);
    return project;
  }

  async list() {
    const folders = await readdir(this.root, { withFileTypes: true });
    const projects = await Promise.all(folders.filter(entry => entry.isDirectory() && uuidPattern.test(entry.name)).map(entry => this.load(entry.name).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    return projects.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, name, revision, updatedAt }) => ({ id, name, revision, updatedAt }));
  }

  async create() {
    const project = { id: randomUUID(), name: '未命名设计', revision: 0, stage: 'discussion', source: 'generated', messages: [], proposal: null, editProposal: null, checks: null, views: null, history: [] };
    await mkdir(join(this.directory(project.id), 'revisions'), { recursive: true });
    return this.save(project);
  }

  async exclusive(id, expectedRevision, operation) {
    if (this.busy.has(id)) throw new Error('这个工程正在处理，请等待当前操作完成。');
    this.busy.add(id);
    try {
      const project = await this.load(id);
      if (project.revision !== expectedRevision) throw new Error('工程版本已经变化，请刷新后再操作。');
      return await operation(project);
    } finally { this.busy.delete(id); }
  }

  async discuss(id, revision, text, modelSelection) {
    return this.exclusive(id, revision, async project => {
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('请填写 1–2000 字的需求或修改说明。');
      const user = { role: 'user', text: text.trim() };
      const model = this.modelSettings(modelSelection);
      let answer;
      if (project.revision) {
        answer = await proposeKiCadEdit(this.revisionDirectory(project), user.text, this.root, model, project.views.pcb);
        project.editProposal = answer.status === 'proposal' ? { ...answer, revision, id: randomUUID() } : null;
      } else {
        answer = await discussDesign([...project.messages, user].slice(-15), this.root, model);
        project.proposal = answer.status === 'proposal' ? { ...answer, id: randomUUID() } : null;
        project.name = project.proposal ? boardProfile.label : project.name;
      }
      project.messages.push(user, { role: 'assistant', text: answer.reply, model: model.provider === 'api' ? model.model : 'Codex（本机默认）' });
      return this.save(project);
    });
  }

  async describe(directory, hasBoard) {
    const schematic = await readFile(join(directory, `${projectName}.kicad_sch`), 'utf8');
    const sheet = inspectKiCad(schematic, 'symbol');
    let pcb = [];
    if (hasBoard) {
      const board = await readFile(join(directory, `${projectName}.kicad_pcb`), 'utf8');
      pcb = inspectKiCad(board, 'footprint');
      const boardValue = readResistance(board, 'footprint').resistance;
      if (readResistance(schematic, 'symbol').resistance !== boardValue) throw new Error('原理图和 PCB 的 R1 阻值不一致，请在 EDA 中同步后导入。');
    }
    if (sheet.length !== 3 || ['J1', 'R1', 'D1'].some(ref => sheet.filter(part => part.ref === ref).length !== 1 || (hasBoard && pcb.filter(part => part.ref === ref).length !== 1)) || (hasBoard && pcb.length !== 3)) {
      throw new Error('首版导回支持本工作台的 J1、R1、D1 指示板；其他板型需要后续适配。');
    }
    const resistance = readResistance(schematic, 'symbol').resistance;
    designFor({ kind: projectName, voltage: boardProfile.voltage, resistance });
    return { schematic: true, pcb: hasBoard, components: sheet.map(part => ({ ...part, ...(part.ref === 'R1' ? { resistance } : {}), boardAt: pcb.find(item => item.ref === part.ref)?.at })) };
  }

  async setResistance(id, revision, resistance) {
    return this.exclusive(id, revision, async project => {
      if (!project.views?.schematic) throw new Error('请先生成原理图，再修改元件属性。');
      const before = resistanceNumber(project.views.components.find(part => part.ref === 'R1').value);
      const answer = resistorChange(before, resistance);
      project.editProposal = answer.status === 'proposal' ? { ...answer, revision, id: randomUUID() } : null;
      project.messages.push({ role: 'user', text: `在属性中将 R1 设置为 ${resistance} Ω。` }, { role: 'assistant', text: answer.reply });
      return this.save(project);
    });
  }

  async publishRevision(project, directory, stage, checks, note, preparedViews) {
    const hasBoard = stage !== 'schematic';
    const views = preparedViews || await this.describe(directory, hasBoard);
    await renderKiCad(directory, hasBoard, !(project.stage === 'schematic' && stage === 'pcb'));
    const number = project.revision + 1;
    // Only the atomic metadata replacement publishes a prepared, immutable snapshot.
    // Interrupted preparation cannot replace a working revision or occupy its next number.
    project.revision = number;
    project.stage = stage;
    project.checks = Object.fromEntries(Object.entries(checks).map(([name, result]) => [name, { ...result, report: `${name}.json` }]));
    project.views = views;
    project.proposal = null;
    project.editProposal = null;
    project.explanation = null;
    project.history.push({ revision: number, artifact: basename(directory), note, at: new Date().toISOString() });
    return this.save(project);
  }

  async prepare(project, copyCurrent) {
    const directory = join(this.directory(project.id), 'revisions', `snapshot-${randomUUID()}`);
    if (copyCurrent) await cp(this.revisionDirectory(project), directory, { recursive: true });
    return directory;
  }

  async confirm(id, revision, proposalId) {
    return this.exclusive(id, revision, async project => {
      if (project.stage === 'discussion') {
        if (!project.proposal || project.proposal.id !== proposalId) throw new Error('方案已经变化，请重新核对并确认。');
        const directory = await this.prepare(project, false);
        const result = await buildConfirmedSchematic(project.proposal, directory, true);
        return this.publishRevision(project, directory, 'schematic', { erc: result.checks }, '确认方案，生成原理图');
      }
      if (project.editProposal) {
        if (project.editProposal.id !== proposalId || project.editProposal.revision !== revision) throw new Error('修改提案已经过期。');
        const edit = project.editProposal.edit;
        const before = readResistance(await readFile(join(this.revisionDirectory(project), `${projectName}.kicad_sch`), 'utf8'), 'symbol').resistance;
        if (before !== edit.before) throw new Error('元件值已经变化，请重新提出修改。');
        const directory = await this.prepare(project, true);
        const hasBoard = project.views.pcb;
        await reviseKiCad(join(directory, `${projectName}.kicad_sch`), hasBoard ? join(directory, `${projectName}.kicad_pcb`) : null, edit.after);
        const [erc, drc] = await Promise.all([verifySchematic(directory), hasBoard ? verifyBoard(directory) : null]);
        if (!hasBoard && erc.passed) await recordCheckedSchematic(directory, { kind: projectName, voltage: boardProfile.voltage, resistance: edit.after });
        return this.publishRevision(project, directory, hasBoard ? 'pcb' : 'schematic', drc ? { erc, drc } : { erc }, `R1：${edit.before} Ω → ${edit.after} Ω`);
      }
      if (project.stage !== 'schematic' || !project.checks.erc.passed || proposalId !== 'schematic') throw new Error('当前确认请求已经失效，请重新核对原理图或修改提案。');
      const directory = await this.prepare(project, true);
      const result = await routeConfirmedSchematic(directory, true);
      return this.publishRevision(project, directory, 'pcb', { erc: project.checks.erc, drc: result.checks }, '确认原理图，生成布局和布线');
    });
  }

  async importArchive(bytes, name) {
    if (!name.toLowerCase().endsWith('.zip')) throw new Error('请选择 KiCad 工程 ZIP。嘉立创原生工程往返正在适配。');
    const entries = readArchive(bytes);
    const sheets = Object.keys(entries).filter(file => file.endsWith(`/${projectName}.kicad_sch`) || file === `${projectName}.kicad_sch`);
    if (sheets.length !== 1) throw new Error(`ZIP 中需要唯一的 ${projectName}.kicad_sch 及同目录的 PCB 工程。`);
    const prefix = posix.dirname(sheets[0]) === '.' ? '' : `${posix.dirname(sheets[0])}/`;
    if (!entries[`${prefix}${projectName}.kicad_pcb`] || !entries[`${prefix}${projectName}.kicad_pro`]) throw new Error('ZIP 缺少同目录的原理图、PCB 或工程文件。');
    const project = { id: randomUUID(), name: 'LED 指示板 · 导回', revision: 0, stage: 'discussion', source: 'kicad', messages: [], proposal: null, editProposal: null, history: [] };
    await mkdir(join(this.directory(project.id), 'revisions'), { recursive: true });
    const directory = await this.prepare(project, false);
    await mkdir(directory);
    for (const [file, data] of Object.entries(entries)) {
      if (!file.startsWith(prefix) || !archivedFile(file)) continue;
      const destination = join(directory, file.slice(prefix.length));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    const views = await this.describe(directory, true);
    const [erc, drc] = await Promise.all([verifySchematic(directory), verifyBoard(directory)]);
    project.messages.push({ role: 'assistant', text: '已经读取导回工程，并重新检查原理图和 PCB。可以继续调整 R1 阻值；手工布局、走线和文字会保留。' });
    return this.publishRevision(project, directory, 'pcb', { erc, drc }, '导回 KiCad 工程并复检', views);
  }

  async explain(id, revision, modelSelection) {
    return this.exclusive(id, revision, async project => {
      if (!project.revision) throw new Error('先生成工程，才能查看检查结果。');
      project.explanation = await explainKiCadReports(this.revisionDirectory(project), this.root, this.modelSettings(modelSelection));
      return this.save(project);
    });
  }

  async exportArchive(id, revision) {
    const project = await this.load(id);
    if (project.revision !== revision) throw new Error('工程版本已经变化，请刷新后下载。');
    if (!project.views?.pcb || !project.checks.erc.passed || !project.checks.drc.passed) throw new Error('完整工程需要先通过原理图、板规及连通性检查。');
    const directory = this.revisionDirectory(project);
    const entries = {};
    const walk = async folder => {
      for (const item of await readdir(join(directory, folder), { withFileTypes: true })) {
        const name = posix.join(folder, item.name);
        if (item.isDirectory()) {
          if (archivedFile(`${name}/placeholder`)) await walk(name);
        } else if (archivedFile(name)) entries[name] = new Uint8Array(await readFile(join(directory, name)));
      }
    };
    await walk('');
    return zipSync(entries);
  }
}

function readArchive(bytes) {
  let total = 0;
  let count = 0;
  const entries = unzipSync(bytes, { filter: file => {
    const name = file.name;
    if (name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')) throw new Error('ZIP 包含不安全的路径。');
    total += file.originalSize;
    count += 1;
    if (total > 32 * 1024 * 1024 || count > 512) throw new Error('首版工程 ZIP 解压后不能超过 32 MB 或 512 个文件。');
    return true;
  } });
  return entries;
}
