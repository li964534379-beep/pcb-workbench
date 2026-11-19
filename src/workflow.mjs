import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runKiCad } from './eda.mjs';
import { boardProfile, connections, designFor, drawingParts, projectName } from './design.mjs';
import { generateKiCadBoard, generateKiCadSchematic, readResistance } from './kicad.mjs';
import { discuss, explainChecks, planChange } from './model.mjs';

export async function discussDesign(messages, dataDirectory, settings) {
  const answer = await discuss(messages, dataDirectory, settings);
  if (answer.status !== 'proposal') return responseWithoutDraft(answer, ['voltage', 'ledColor', 'resistance', 'resistanceSource']);
  if (!Number.isInteger(answer.voltage) || !Number.isInteger(answer.resistance) || answer.ledColor !== boardProfile.ledColor || !answer.resistanceSource) {
    throw new Error('方案需要填写供电、确认的 LED 颜色及电阻值来源。');
  }
  if (answer.resistanceSource === 'recommended' && answer.resistance !== boardProfile.resistanceDefault) {
    throw new Error('草案推荐值与板型登记值不一致。');
  }
  const draft = designFor({ kind: boardProfile.kind, voltage: answer.voltage, resistance: answer.resistance });
  const components = drawingParts(draft);
  return {
    status: answer.status,
    reply: answer.reply,
    draft,
    resistanceSource: answer.resistanceSource,
    components: components.map(({ ref, value }) => ({ ref, value })),
    connections: connections(components, 'sheet').map(({ net, endpoints }) => ({
      net, pins: endpoints.map(({ part, pin }) => `${part.ref}.${pin.number}`),
    })),
  };
}

function responseWithoutDraft(answer, draftFields) {
  if (draftFields.some(field => answer[field] !== null)) throw new Error('只有可确认的草案能携带设计参数。');
  return { status: answer.status, reply: answer.reply };
}

async function runKiCadCheck(directory, command, args) {
  const report = join(directory, `${command[1]}.json`);
  await runKiCad([...command, '--format', 'json', '--output', report, ...args]);
  return { data: JSON.parse(await readFile(report, 'utf8')), report };
}

function schematicFindings(data) {
  if (!Array.isArray(data.sheets) || !data.sheets.length || !data.sheets.every(sheet => Array.isArray(sheet.violations))) {
    throw new Error('KiCad 检查报告不完整。');
  }
  return data.sheets.flatMap(sheet => sheet.violations);
}

function boardFindings(data) {
  if (!Array.isArray(data.violations) || !Array.isArray(data.unconnected_items) || !Array.isArray(data.schematic_parity)) {
    throw new Error('KiCad 检查报告不完整。');
  }
  return { violations: data.violations, unconnected: data.unconnected_items, parity: data.schematic_parity };
}

export async function verifySchematic(directory) {
  const { data, report } = await runKiCadCheck(directory, ['sch', 'erc'], [join(directory, `${projectName}.kicad_sch`)]);
  const issues = schematicFindings(data);
  return { passed: !issues.some(issue => issue.severity === 'error'), schematicIssues: issues.length, report };
}

export async function verifyBoard(directory) {
  const { data, report } = await runKiCadCheck(directory, ['pcb', 'drc'], ['--schematic-parity', join(directory, `${projectName}.kicad_pcb`)]);
  const { violations, unconnected, parity } = boardFindings(data);
  const passed = !violations.some(issue => issue.severity === 'error') && !unconnected.length && !parity.length;
  return { passed, boardIssues: violations.length, unconnected: unconnected.length, parityIssues: parity.length, report };
}

const fingerprint = source => createHash('sha256').update(source).digest('hex');

export async function recordCheckedSchematic(directory, draft) {
  const schematic = await readFile(join(directory, `${projectName}.kicad_sch`), 'utf8');
  await writeFile(join(directory, 'workflow.json'), JSON.stringify({ draft: designFor(draft), schematicHash: fingerprint(schematic) }, null, 2));
}

export async function buildConfirmedSchematic(proposal, destination, confirmed) {
  if (confirmed !== true || proposal?.status !== 'proposal' || !proposal.draft) throw new Error('请先确认一份完整的设计草案。');
  const draft = designFor(proposal.draft);
  const directory = resolve(destination);
  await mkdir(directory);
  await generateKiCadSchematic(directory, draft);
  const checks = await verifySchematic(directory);
  if (checks.passed) await recordCheckedSchematic(directory, draft);
  return { status: checks.passed ? 'awaiting_schematic_confirmation' : 'issues', directory, draft, checks };
}

export async function routeConfirmedSchematic(destination, confirmed) {
  if (confirmed !== true) throw new Error('请先确认原理图，再开始布局布线。');
  const directory = resolve(destination);
  const [workflow, schematic] = await Promise.all([
    readFile(join(directory, 'workflow.json'), 'utf8').then(JSON.parse),
    readFile(join(directory, `${projectName}.kicad_sch`), 'utf8'),
  ]);
  if (workflow.schematicHash !== fingerprint(schematic)) throw new Error('原理图已经变化，请重新生成和检查对应版本后再布线。');
  const draft = designFor(workflow.draft);
  await generateKiCadBoard(directory, draft, schematic);
  const checks = await verifyBoard(directory);
  return { status: checks.passed ? 'verified' : 'issues', directory, draft, checks };
}

export async function proposeKiCadEdit(directory, instruction, dataDirectory, settings, hasBoard = true) {
  const files = [[`${projectName}.kicad_sch`, 'symbol'], ...(hasBoard ? [[`${projectName}.kicad_pcb`, 'footprint']] : [])];
  const [schematicValue, boardValue] = await Promise.all(files.map(async ([file, kind]) => readResistance(await readFile(join(directory, file), 'utf8'), kind).resistance));
  if (hasBoard && schematicValue !== boardValue) throw new Error('原理图与 PCB 的 R1 阻值不一致，请先在 KiCad 同步工程。');
  const before = schematicValue;
  const answer = await planChange(before, instruction, dataDirectory, settings, hasBoard);
  if (answer.status !== 'proposal') return responseWithoutDraft(answer, ['reference', 'resistance']);
  if (answer.reference !== 'R1' || !Number.isInteger(answer.resistance)) throw new Error('修改草案需要明确指向 R1，并填写整数欧姆值。');
  return resistorChange(before, answer.resistance, answer.reply);
}

export function resistorChange(before, after, reply = `拟将 R1 从 ${before} Ω 改为 ${after} Ω。确认后写入工程并复检。`) {
  if (!Number.isInteger(after)) throw new Error('请填写整数欧姆值。');
  designFor({ kind: boardProfile.kind, voltage: boardProfile.voltage, resistance: after });
  if (before === after) return { status: 'clarify', reply: `R1 目前已经是 ${before} Ω，无需修改。` };
  return { status: 'proposal', reply, edit: { component: 'R1', property: 'resistance', before, after, unit: 'Ω' } };
}

async function savedReport(directory, name) {
  try {
    return JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function reportIssues(check, records) {
  const reportText = value => typeof value === 'string' ? value.slice(0, 500) : '';
  return records.map((issue, index) => ({
    issueId: `${check}-${index + 1}`,
    check,
    severity: reportText(issue.severity),
    type: reportText(issue.type),
    description: reportText(issue.description),
    objects: Array.isArray(issue.items) ? issue.items.slice(0, 4).map(item => reportText(item.description)) : [],
  }));
}

export async function explainKiCadReports(directory, dataDirectory, settings) {
  const [erc, drc] = await Promise.all([savedReport(directory, 'erc'), savedReport(directory, 'drc')]);
  if (!erc && !drc) throw new Error('工程目录缺少 KiCad 检查报告。');
  const reports = [erc && 'ERC', drc && 'DRC'].filter(Boolean);
  const issues = erc ? reportIssues('ERC', schematicFindings(erc)) : [];
  if (drc) {
    const { violations, unconnected, parity } = boardFindings(drc);
    issues.push(...reportIssues('DRC', violations), ...reportIssues('未连通', unconnected), ...reportIssues('图板一致性', parity));
  }
  if (!issues.length) return { reports, totalIssues: 0, findings: [] };

  const blocking = issue => issue.severity === 'error' || issue.check === '未连通' || issue.check === '图板一致性';
  const selected = issues.sort((first, second) => Number(blocking(second)) - Number(blocking(first))).slice(0, 8);
  const { findings } = await explainChecks(selected, dataDirectory, settings);
  const explanations = new Map(findings.map(finding => [finding.issueId, finding]));
  if (findings.length !== selected.length || selected.some(issue => !explanations.has(issue.issueId))) {
    throw new Error('模型解读引用的检查编号与报告不一致。');
  }
  return {
    reports,
    totalIssues: issues.length,
    findings: selected.map(issue => ({ ...issue, ...explanations.get(issue.issueId) })),
  };
}
