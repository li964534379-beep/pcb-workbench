import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connections, drawingParts, projectName, segments } from './design.mjs';

const q = value => JSON.stringify(String(value));
const uuid = () => `(uuid ${q(randomUUID())})`;
const xy = point => point.join(' ');
const effects = '(effects (font (size 1.27 1.27)))';
const line = (start, end) => `(polyline (pts (xy ${xy(start)}) (xy ${xy(end)})) (stroke (width 0.254) (type default)) (fill (type none)))`;
const body = (start, end) => `(rectangle (start ${xy(start)}) (end ${xy(end)}) (stroke (width 0.254) (type default)) (fill (type background)))`;
const symbolBodies = {
  Input: body([-2.54, 2.54], [2.54, -7.62]),
  Resistor: body([-2.54, 1.05], [2.54, -1.05]),
  LED: `${line([-2.54, 1.4], [-2.54, -1.4])}${line([-2.54, -1.4], [2.54, 0])}${line([2.54, 0], [-2.54, 1.4])}${line([2.54, 1.4], [2.54, -1.4])}${line([-0.5, 1.9], [0.9, 3.3])}${line([1.1, 1.9], [2.5, 3.3])}`,
};

function symbol(part, name) {
  const pins = part.pins.map(pin => `(pin passive line (at ${xy(pin.symbol)}) (length 2.54)
    (name ${q(pin.name)} ${effects}) (number ${q(pin.number)} ${effects}))`).join('\n');
  return `(symbol ${q(name)} (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" ${q(part.ref[0])} (at 0 3.81 0) ${effects})
    (property "Value" ${q(part.type)} (at 0 -3.81 0) ${effects})
    (property "Footprint" ${q(`Workbench:${part.type}`)} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol ${q(`${part.type}_0_1`)} ${symbolBodies[part.type]})
    (symbol ${q(`${part.type}_1_1`)} ${pins}))`;
}

function schematic(instances, sheetId) {
  const wires = connections(instances, 'sheet').flatMap(edge => segments(edge.points).map(([a, b]) => `(wire (pts (xy ${xy(a)}) (xy ${xy(b)})) (stroke (width 0) (type default)) ${uuid()})`));
  const labelsAt = [[48.26, 38.1], [78.74, 38.1], [71.12, 50.8]];
  const netLabels = connections(instances, 'sheet').map(({ net }, index) => `(label ${q(net)} (at ${xy(labelsAt[index])} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) ${uuid()})`);
  const symbols = instances.map(part => `(symbol (lib_id ${q(`Workbench:${part.type}`)}) (at ${xy(part.sheet)} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${q(part.id)})
    (property "Reference" ${q(part.ref)} (at ${part.sheet[0]} 33.02 0) ${effects})
    (property "Value" ${q(part.value)} (at ${part.sheet[0]} 35.56 0) ${effects})
    (property "Footprint" ${q(`Workbench:${part.type}`)} (at ${xy(part.sheet)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    ${part.pins.map(pin => `(pin ${q(pin.number)} ${uuid()})`).join(' ')}
    (instances (project ${q(projectName)} (path ${q(`/${sheetId}`)} (reference ${q(part.ref)}) (unit 1)))))`);
  return `(kicad_sch (version 20250114) (generator "pcb_workbench") (uuid ${q(sheetId)}) (paper "A4")
    (title_block (title "5 V LED Indicator"))
    (lib_symbols ${instances.map(part => symbol(part, `Workbench:${part.type}`)).join('\n')})
    ${wires.join('\n')}\n${netLabels.join('\n')}\n${symbols.join('\n')}
    (sheet_instances (path "/" (page "1"))))\n`;
}

function footprintBody(part, netMap = null) {
  const xmax = Math.max(...part.pins.map(pin => pin.pad[0])) + 1.25;
  const ymax = Math.max(...part.pins.map(pin => pin.pad[1])) + 1.25;
  const box = (layer, width, padding) => `(fp_rect (start ${-1.25 - padding} ${-1.25 - padding}) (end ${xmax + padding} ${ymax + padding}) (stroke (width ${width}) (type default)) (fill none) (layer ${q(layer)}) ${uuid()})`;
  return [
    '(attr through_hole)',
    box('F.SilkS', .12, 0), box('F.CrtYd', .05, .25),
    ...part.pins.map(pin => `(pad ${q(pin.number)} thru_hole ${pin.number === '1' ? 'rect' : 'circle'} (at ${xy(pin.pad)}) (size 1.7 1.7) (drill 0.9) (layers "*.Cu" "*.Mask")${netMap ? ` (net ${netMap[pin.net]} ${q(`/${pin.net}`)})` : ''} ${uuid()})`),
  ].join('\n');
}

function footprint(part, netMap, rootId) {
  const property = (key, value, pos, layer, hide = '') => `(property ${q(key)} ${q(value)} (at 0 ${pos} 0) (layer ${q(layer)}) ${hide} ${uuid()} (effects (font (size 0.9 0.9) (thickness 0.12))))`;
  return `(footprint ${q(`Workbench:${part.type}`)} (layer "F.Cu") (at ${xy(part.board)}) ${uuid()} (path ${q(`/${rootId}/${part.id}`)}) (sheetname "") (sheetfile "led-indicator.kicad_sch")
    ${property('Reference', part.ref, -2.3, 'F.SilkS')} ${property('Value', part.value, 4.6, 'F.Fab', '(hide yes)')}
    ${footprintBody(part, netMap)})`;
}

function board(spec, instances, sheetId) {
  const routed = connections(instances, 'board');
  const netMap = Object.fromEntries(routed.map(edge => [edge.net, edge.id]));
  const tracks = routed.flatMap(edge => segments(edge.points).map(([start, end]) => `(segment (start ${xy(start)}) (end ${xy(end)}) (width 0.4) (layer ${q(edge.layer)}) (net ${edge.id}) ${uuid()})`));
  return `(kicad_pcb (version 20241229) (generator "pcb_workbench") (general (thickness 1.6)) (paper "A4")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (35 "F.Fab" user))
    (setup (pad_to_mask_clearance 0))
    ${routed.map(({ id, net }) => `(net ${id} ${q(`/${net}`)})`).join('\n')}
    ${instances.map(part => footprint(part, netMap, sheetId)).join('\n')}
    (gr_rect (start 0 0) (end ${spec.width} ${spec.height}) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") ${uuid()})
    (gr_text "5V LED" (at 21 16) (layer "F.SilkS") ${uuid()} (effects (font (size 1 1) (thickness 0.15))))
    ${tracks.join('\n')})\n`;
}

export async function generateKiCadSchematic(directory, spec) {
  const instances = drawingParts(spec).map(part => ({ ...part, id: randomUUID() }));
  const sheetId = randomUUID();
  const prettyDirectory = join(directory, 'Workbench.pretty');
  await mkdir(prettyDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, `${projectName}.kicad_sch`), schematic(instances, sheetId)),
    writeFile(join(directory, `${projectName}.kicad_pro`), JSON.stringify({ meta: { filename: `${projectName}.kicad_pro`, version: 1 }, board: {}, schematic: {} }, null, 2)),
    writeFile(join(directory, 'Workbench.kicad_sym'), `(kicad_symbol_lib (version 20241209) (generator "pcb_workbench")\n${instances.map(part => symbol(part, part.type)).join('\n')})\n`),
    writeFile(join(directory, 'sym-lib-table'), '(sym_lib_table (version 7) (lib (name "Workbench") (type "KiCad") (uri "${KIPRJMOD}/Workbench.kicad_sym") (options "") (descr "")))\n'),
    writeFile(join(directory, 'fp-lib-table'), '(fp_lib_table (version 7) (lib (name "Workbench") (type "KiCad") (uri "${KIPRJMOD}/Workbench.pretty") (options "") (descr "")))\n'),
    ...instances.map(part => writeFile(join(prettyDirectory, `${part.type}.kicad_mod`), `(footprint ${q(part.type)} (version 20241229) (generator "pcb_workbench") (layer "F.Cu")\n(fp_text reference "REF**" (at 0 -2.3) (layer "F.SilkS") ${effects})\n(fp_text value ${q(part.type)} (at 0 4.6) (layer "F.Fab") ${effects})\n${footprintBody(part)})\n`)),
  ]);
}

export async function generateKiCad(directory, spec) {
  await generateKiCadSchematic(directory, spec);
  await generateKiCadBoard(directory, spec);
}

function parse(source) {
  const stack = [];
  let root;
  for (const match of source.matchAll(/\(|\)|"(?:\\.|[^"\\])*"|[^()\s"]+/g)) {
    const token = match[0];
    if (token === '(') {
      const node = { children: [], start: match.index };
      stack.at(-1)?.children.push(node);
      root ??= node;
      stack.push(node);
    } else if (token === ')') {
      const node = stack.pop();
      if (!node) throw new Error('KiCad 文件括号不匹配');
      node.end = match.index + 1;
    } else {
      const value = token.startsWith('"') ? JSON.parse(token) : token;
      stack.at(-1)?.children.push({ value, start: match.index, end: match.index + token.length });
    }
  }
  if (stack.length || !root) throw new Error('KiCad 文件结构无效');
  return root;
}

const children = (node, kind) => node.children.filter(child => child.children?.[0]?.value === kind);
const property = (node, name) => children(node, 'property').find(child => child.children[1]?.value === name)?.children[2];

export async function generateKiCadBoard(directory, spec, source) {
  const schematicSource = source ?? await readFile(join(directory, `${projectName}.kicad_sch`), 'utf8');
  const root = parse(schematicSource);
  const idOf = node => children(node, 'uuid')[0]?.children[1]?.value;
  const sheetId = idOf(root);
  const placed = children(root, 'symbol');
  const instances = drawingParts(spec).map(part => {
    const matches = placed.filter(node => property(node, 'Reference')?.value === part.ref);
    if (matches.length !== 1 || property(matches[0], 'Value')?.value !== part.value || !idOf(matches[0])) {
      throw new Error(`原理图中的 ${part.ref} 与已确认的方案不一致。`);
    }
    return { ...part, id: idOf(matches[0]) };
  });
  if (!sheetId || placed.length !== instances.length) throw new Error('原理图器件与已确认的方案不一致。');
  await writeFile(join(directory, `${projectName}.kicad_pcb`), board(spec, instances, sheetId), { flag: 'wx' });
}

export function readResistance(source, kind) {
  const entries = children(parse(source), kind).filter(node => property(node, 'Reference')?.value === 'R1');
  const value = entries.length === 1 && property(entries[0], 'Value');
  if (!value) throw new Error('工程需要唯一的 R1。');
  return { ...value, resistance: resistanceNumber(value.value) };
}

export function resistanceNumber(value) {
  const match = typeof value === 'string' && /^(\d+(?:\.\d+)?)\s*(R|Ω|ohms?|k(?:Ω|ohms?)?)?$/i.exec(value.trim());
  const resistance = match && Number(match[1]) * (match[2]?.toLowerCase().startsWith('k') ? 1000 : 1);
  if (!Number.isInteger(resistance)) throw new Error('R1 需要整数欧姆值，例如 470、470R 或 0.47kΩ。');
  return resistance;
}

export function inspectKiCad(source, kind) {
  const root = parse(source);
  if (root.children[0]?.value !== (kind === 'symbol' ? 'kicad_sch' : 'kicad_pcb')) throw new Error('工程文件类型不正确。');
  return children(root, kind).map(node => ({
    ref: property(node, 'Reference')?.value,
    value: property(node, 'Value')?.value,
    footprint: kind === 'symbol' ? property(node, 'Footprint')?.value : node.children[1]?.value,
    at: children(node, 'at')[0]?.children.slice(1, 3).map(token => Number(token.value)),
  }));
}

export async function reviseKiCad(schFile, pcbFile, resistance) {
  const files = [[schFile, 'symbol'], ...(pcbFile ? [[pcbFile, 'footprint']] : [])];
  const revisions = await Promise.all(files.map(async ([file, kind]) => {
    const source = await readFile(file, 'utf8');
    const value = readResistance(source, kind);
    return { file, old: value.value, resistance: value.resistance, updated: source.slice(0, value.start) + q(`${resistance}R`) + source.slice(value.end) };
  }));
  if (revisions.length === 2 && revisions[0].resistance !== revisions[1].resistance) throw new Error('原理图与 PCB 的 R1 阻值不一致，请先在 KiCad 同步工程。');
  await Promise.all(revisions.map(entry => writeFile(entry.file, entry.updated)));
  return revisions[0].old;
}
