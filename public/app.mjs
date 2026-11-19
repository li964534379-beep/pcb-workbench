const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
let project = null;
let projects = [];
let settings;
let modelChoice;
let renderedMessages = Symbol('initial');
let capability;
let page = 'discussion';
let view = 'schematic';
let part = '';
let busy = true;
let noticeTimer;
let previewKey = '';
let loadingKey = '';
let previewSequence = 0;
let camera;
const previewCache = new Map();

function applySettings(next, resetChoice = true) {
  settings = next;
  if (resetChoice || !modelChoice) modelChoice = settings.provider === 'api' ? { provider: 'api', model: settings.model } : { provider: 'codex' };
}

function selectedModel() { return { ...modelChoice, connectionId: settings.connectionId }; }

function rememberModel() {
  try { localStorage.setItem('pcb-model', JSON.stringify({ ...modelChoice, baseUrl: settings.baseUrl })); } catch { /* Browser storage is optional. */ }
}

function renderModels() {
  const ids = [...new Set([...(settings?.models || []), modelChoice?.provider === 'api' && modelChoice.model].filter(Boolean))];
  const placeholder = modelChoice?.provider === 'api' && !modelChoice.model ? [new Option('请选择 API 模型…', 'api:')] : [];
  $('chat-model').replaceChildren(new Option('Codex（本机默认）', 'codex'), ...placeholder, ...ids.map(id => new Option(id, `api:${id}`)), new Option('连接 / 手动配置模型…', 'configure'));
  $('chat-model').value = modelChoice?.provider === 'api' ? `api:${modelChoice.model}` : 'codex';
  $('chat-model').disabled = busy || !settings;
  $('refresh-models').disabled = busy || !settings;
  $('model-hint').textContent = !settings?.apiConfigured ? '在模型菜单里连接自己的 API，即可选择其他模型。' : modelChoice?.provider === 'api' && !modelChoice.model ? '先获取模型列表并选择；也可在设置里手动填写名称。' : '获取列表后切换模型；不支持列表的接口可手动填写。';
  $('model-badge').textContent = modelChoice?.provider === 'api' ? '自定义 API' : '本机 Codex';
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(text, kind = '', persistent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').className = `notice ${kind}`;
  $('notice').hidden = !text;
  if (text && !persistent) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 8000);
}

async function api(path, payload, options = {}) {
  const response = await fetch(path, payload === undefined ? options : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成。');
  return result;
}

function remember() { try { localStorage.setItem('pcb-project', project.id); } catch { /* File storage still works without browser storage. */ } }

function updateProject(next) {
  if (project?.id !== next.id || project?.revision !== next.revision) {
    previewCache.clear(); previewKey = ''; loadingKey = ''; camera = undefined; previewSequence += 1;
  }
  project = next;
  remember();
  const existing = projects.findIndex(item => item.id === project.id);
  if (existing >= 0) projects.splice(existing, 1);
  projects.unshift({ id: project.id, name: project.name, revision: project.revision });
  render();
}

async function task(label, work) {
  if (busy) return;
  busy = true;
  render();
  notice(label, 'busy', true);
  try {
    await work();
    notice('');
  } catch (error) { notice(error.message, 'error', true); }
  finally { busy = false; render(); }
}

function renderMessages() {
  if (renderedMessages === (project?.messages || null)) return;
  renderedMessages = project?.messages || null;
  const panel = $('messages');
  panel.replaceChildren();
  const messages = project?.messages.length ? project.messages : [{ role: 'assistant', text: '你想做什么电路？告诉我它的用途和供电条件，我会先帮你整理可确认的方案。\n\n首版可以实际生成一块 5V 红色 LED 指示板。' }];
  for (const message of messages) {
    const item = element('div', undefined, `message ${message.role}`);
    item.append(element('span', message.role === 'user' ? '你' : `设计助手${message.model ? ` · ${message.model}` : ''}`, 'message-label'), document.createTextNode(message.text));
    panel.append(item);
  }
  panel.scrollTop = panel.scrollHeight;
}

function facts(rows, className) {
  const list = element('dl', undefined, className);
  for (const [label, value] of rows) {
    const row = element('div');
    row.append(element('dt', label), element('dd', String(value ?? '—')));
    list.append(row);
  }
  return list;
}

function renderProposal() {
  const proposal = project?.proposal;
  const actualR1 = project?.views?.components.find(item => item.ref === 'R1');
  $('proposal').hidden = !proposal && !actualR1;
  if ($('proposal').hidden) return;
  $('proposal').replaceChildren(element('h2', proposal ? '待确认方案' : '当前工程'));
  const rows = proposal ? [
    ['用途', '通电亮红灯'], ['输入供电', `${proposal.draft.voltage} V DC`], ['限流电阻 R1', `${proposal.draft.resistance} Ω`], ['板型', `双层 · ${proposal.draft.width} × ${proposal.draft.height} mm`],
  ] : project.views.components.map(component => [component.ref, component.value]);
  $('proposal').append(facts(rows, 'spec-list'));
  if (proposal) {
    $('proposal').append(element('p', proposal.resistanceSource === 'recommended' ? 'R1 使用工作台推荐值，确认后生成原理图。' : 'R1 使用你指定的阻值，确认后生成原理图。', 'caption'));
    const nets = element('div', undefined, 'net-list');
    for (const connection of proposal.connections) nets.append(element('div', `${connection.net}：${connection.pins.join(' · ')}`));
    $('proposal').append(nets);
  }
}

function renderInspector() {
  const components = project?.views?.components || [];
  if (!components.some(item => item.ref === part)) part = '';
  $('part-select').replaceChildren(new Option(view === 'pcb' ? 'PCB' : '图纸', ''), ...components.map(item => new Option(item.ref, item.ref)));
  $('part-select').value = part;
  const component = components.find(item => item.ref === part);
  const rows = component
    ? [['位号', component.ref], ['值', component.value], ['封装', component.footprint], ['位置 / mm', (view === 'pcb' ? component.boardAt : component.at)?.map(value => value.toFixed(2)).join(', ')]]
    : [['视图', view === 'pcb' ? 'PCB · 双层板' : '原理图 · A4'], ['元件', `${components.length} 个`], ['来源', project?.source === 'kicad' ? 'KiCad 导回' : '工作台生成']];
  $('part-properties').replaceChildren(...facts(rows).children);
  $('resistance-form').hidden = part !== 'R1' || !project?.views?.schematic;
  if (part === 'R1' && document.activeElement !== $('resistance')) $('resistance').value = component.resistance ?? Number(component.value.replace(/R$/i, ''));
  $('resistance-form').querySelector('button').disabled = busy;
  $('layers').hidden = view !== 'pcb';
  $('history').replaceChildren(element('strong', '版本记录'));
  for (const entry of (project?.history || []).slice(-3).reverse()) $('history').append(element('p', `R${entry.revision} · ${entry.note}`));
  for (const hit of $('canvas').querySelectorAll('[data-part]')) hit.classList.toggle('selected', hit.dataset.part === part);
}

function renderReport() {
  const report = project?.explanation;
  $('report-panel').hidden = !report;
  if (!report) return;
  $('report-panel').replaceChildren(element('strong', `检查报告 · ${report.totalIssues} 项`));
  if (!report.totalIssues) $('report-panel').append(element('p', '本版本的 KiCad 检查报告没有发现规则问题。硬件实际工作情况仍需打样测试。'));
  for (const finding of report.findings) {
    const item = element('article');
    item.append(element('strong', `${finding.issueId} · ${finding.type}`), element('p', finding.description), element('p', finding.interpretation), element('p', `下一步：${finding.nextStep}`));
    $('report-panel').append(item);
  }
  if (report.totalIssues > report.findings.length && report.findings.length) $('report-panel').append(element('p', '本次优先解读最多 8 项，完整报告保留在工程版本中。'));
}

function renderChecks() {
  const erc = project?.checks?.erc;
  const drc = project?.checks?.drc;
  let title = '等待设计方案';
  let detail = '先在左侧描述需求';
  if (project?.proposal) { title = '方案已整理，等待确认'; detail = '确认用途、供电和阻值后生成原理图'; }
  if (erc) {
    title = erc.passed ? '原理图检查通过' : '原理图需要处理';
    detail = `ERC ${erc.schematicIssues} 项${drc ? ` · DRC ${drc.boardIssues} 项 · 未连接 ${drc.unconnected} · 图板差异 ${drc.parityIssues}` : ' · 确认后继续画板'} `;
  }
  if (drc) title = erc.passed && drc.passed ? 'KiCad 规则检查通过' : '工程检查发现问题';
  $('check-title').textContent = title;
  $('check-detail').textContent = detail;
  $('check-icon').textContent = erc?.passed && (!drc || drc.passed) ? '✓' : erc ? '!' : '○';
  $('explain').hidden = !erc;
  $('explain').disabled = busy || (modelChoice?.provider === 'api' && !modelChoice.model);
}

function render() {
  $('projects').replaceChildren(new Option(project ? '打开其他工程' : '选择工程', ''), ...projects.map(item => new Option(`${item.name} · R${item.revision}`, item.id)));
  $('projects').value = project?.id || '';
  $('project-name').textContent = project?.name || '从一个想法开始';
  $('revision').textContent = project?.revision ? `REV ${project.revision}` : '未生成';
  $('saved-state').textContent = busy ? '正在处理…' : project ? '已保存在本机' : '保存在本机';
  renderModels();
  $('instruction').placeholder = project?.revision ? '例如：把 R1 改成 470 欧姆…' : '描述你想做的电路…';
  $('example').hidden = !!project?.revision;
  $('send').disabled = busy || (modelChoice?.provider === 'api' && !modelChoice.model);
  $('instruction').disabled = busy;
  for (const id of ['new-project', 'projects', 'import-project', 'settings-button', 'example']) $(id).disabled = busy;
  const hasSheet = !!project?.views?.schematic;
  const hasBoard = !!project?.views?.pcb;
  const ready = hasBoard && project.checks.erc.passed && project.checks.drc.passed;
  $('plan-panel').hidden = page !== 'discussion';
  $('editor').hidden = !['schematic', 'pcb'].includes(page);
  $('export-panel').hidden = page !== 'export';
  $('pcb-tab').disabled = !hasBoard;
  for (const button of document.querySelectorAll('[data-stage]')) {
    const available = button.dataset.stage === 'discussion' || (button.dataset.stage === 'schematic' && hasSheet) || (button.dataset.stage === 'pcb' && hasBoard) || (button.dataset.stage === 'export' && ready);
    button.disabled = busy || !available;
    if (button.dataset.stage === page) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  }
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-selected', String(button.dataset.view === view));
  const pendingEdit = project?.editProposal;
  $('edit-proposal').hidden = !pendingEdit;
  if (pendingEdit) {
    const body = element('div');
    body.append(element('strong', `待确认修改 · R1：${pendingEdit.edit.before} Ω → ${pendingEdit.edit.after} Ω`), element('p', pendingEdit.reply));
    $('edit-proposal').replaceChildren(body);
  }
  let label = '确认方案，生成原理图';
  let enabled = !!project?.proposal;
  if (project?.stage === 'schematic') { label = '确认原理图，布局布线'; enabled = project.checks.erc.passed; }
  if (hasBoard) { label = page === 'export' ? '下载工程 ZIP' : '查看导出工程'; enabled = ready; }
  if (pendingEdit) { label = '确认修改并复检'; enabled = true; }
  $('next').textContent = label;
  $('next').disabled = busy || !enabled;
  if (ready) $('download').href = `/api/projects/${project.id}/export?revision=${project.revision}`;
  renderMessages(); renderProposal(); renderInspector(); renderChecks(); renderReport();
  if (!$('editor').hidden) void loadPreview();
}

async function svgDocument(kind) {
  const key = `${project.id}:${project.revision}:${kind}`;
  if (!previewCache.has(key)) previewCache.set(key, (async () => {
    const response = await fetch(`/api/projects/${project.id}/preview?revision=${project.revision}&kind=${kind}`);
    if (!response.ok) throw new Error('工程图预览读取失败。');
    return response.text();
  })());
  const doc = new DOMParser().parseFromString(await previewCache.get(key), 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('工程图格式无法显示。');
  return doc.documentElement;
}

async function loadPreview() {
  if (!project?.views || (view === 'pcb' && !project.views.pcb)) return;
  const key = `${project.id}:${project.revision}:${view}`;
  if (previewKey === key || loadingKey === key) return;
  loadingKey = key;
  const sequence = ++previewSequence;
  const selectedView = view;
  const components = project.views.components;
  try {
    const layers = selectedView === 'pcb' ? ['back', 'front', 'silk'] : ['schematic'];
    const sources = await Promise.all(layers.map(svgDocument));
    if (sequence !== previewSequence) return;
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('aria-label', selectedView === 'pcb' ? '真实 KiCad PCB 图' : '真实 KiCad 原理图');
    svg.setAttribute('role', 'img');
    for (let index = 0; index < sources.length; index += 1) {
      const group = document.createElementNS(svgNS, 'g');
      group.dataset.previewLayer = layers[index];
      group.append(...Array.from(sources[index].children).map(node => document.importNode(node, true)));
      svg.append(group);
    }
    $('canvas').replaceChildren(svg);
    $('canvas').classList.toggle('board', selectedView === 'pcb');
    const bounds = svg.getBBox();
    const padding = selectedView === 'pcb' ? 5 : 8;
    const fit = { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
    if (!bounds.width || !bounds.height) throw new Error('工程图没有可显示的对象。');
    camera = { svg, fit, ...fit, zoom: 1 };
    for (const component of components) {
      const at = selectedView === 'pcb' ? component.boardAt : component.at;
      if (!at?.every(Number.isFinite)) continue;
      const rect = document.createElementNS(svgNS, 'rect');
      const isBoard = selectedView === 'pcb';
      const wide = isBoard && component.ref === 'R1';
      rect.setAttribute('x', at[0] - (isBoard ? 2 : 7));
      rect.setAttribute('y', at[1] - (isBoard ? 3 : 7));
      rect.setAttribute('width', isBoard ? wide ? 12 : 5 : 14);
      rect.setAttribute('height', isBoard ? 10 : 15);
      rect.setAttribute('class', 'component-hit');
      rect.setAttribute('tabindex', '0');
      rect.setAttribute('aria-label', `选择元件 ${component.ref}`);
      rect.dataset.part = component.ref;
      svg.append(rect);
    }
    previewKey = key;
    $('view-label').textContent = selectedView === 'pcb' ? 'PCB · F.Cu / B.Cu · mm' : 'SCH-01 · 原生原理图 · mm';
    applyCamera(); applyLayers(); renderInspector();
  } catch (error) {
    if (sequence === previewSequence) { previewKey = ''; notice(error.message, 'error'); }
  } finally { if (sequence === previewSequence) loadingKey = ''; }
}

function applyCamera() {
  if (!camera) return;
  camera.svg.setAttribute('viewBox', `${camera.x} ${camera.y} ${camera.width} ${camera.height}`);
  $('zoom').textContent = `${Math.round(camera.zoom * 100)}%`;
  $('zoom-out').disabled = camera.zoom <= .5;
  $('zoom-in').disabled = camera.zoom >= 8;
}

function zoom(factor) {
  if (!camera) return;
  const zoom = Math.min(8, Math.max(.5, camera.zoom * factor));
  const width = camera.fit.width / zoom;
  const height = camera.fit.height / zoom;
  Object.assign(camera, { x: camera.x + (camera.width - width) / 2, y: camera.y + (camera.height - height) / 2, width, height, zoom });
  applyCamera();
}

function applyLayers() {
  for (const input of document.querySelectorAll('[data-layer]')) {
    const layer = $('canvas').querySelector(`[data-preview-layer="${input.dataset.layer}"]`);
    if (layer) layer.style.opacity = input.checked ? '1' : input.dataset.layer === 'front' ? '.12' : '0';
  }
}

async function sendInstruction(text) {
  const modelSelection = selectedModel();
  await task('正在整理需求与设计提案…', async () => {
    if (!project) updateProject(await api('/api/projects', {}));
    const result = await api(`/api/projects/${project.id}/chat`, { revision: project.revision, text, modelSelection });
    updateProject(result);
    $('instruction').value = '';
    if (!project.revision) page = 'discussion';
  });
}

$('chat-form').addEventListener('submit', event => { event.preventDefault(); if (!$('send').disabled && $('instruction').value.trim()) void sendInstruction($('instruction').value.trim()); });
$('instruction').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
});
$('example').addEventListener('click', () => { $('instruction').value = '做一块 5V 直流供电、通电亮红灯的 LED 指示板，限流电阻请你建议。'; $('instruction').focus(); });
$('new-project').addEventListener('click', () => task('正在建立本机工程…', async () => { page = 'discussion'; view = 'schematic'; part = ''; updateProject(await api('/api/projects', {})); }));
$('projects').addEventListener('change', event => {
  const id = event.target.value;
  if (id) void task('正在打开工程…', async () => { const result = await api(`/api/projects/${id}`); page = result.stage; view = result.views?.pcb ? 'pcb' : 'schematic'; updateProject(result); });
});

document.querySelector('.steps').addEventListener('click', event => {
  const button = event.target.closest('[data-stage]');
  if (!button || button.disabled) return;
  page = button.dataset.stage;
  if (page === 'pcb' || page === 'schematic') view = page;
  render();
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { view = button.dataset.view; render(); });
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const button = document.querySelector(`[data-view="${view === 'pcb' ? 'schematic' : 'pcb'}"]`);
  if (!button.disabled) { button.click(); button.focus(); }
});

$('next').addEventListener('click', () => {
  if (!project || busy) return;
  if (project.views?.pcb && !project.editProposal) {
    if (page === 'export') $('download').click(); else { page = 'export'; render(); }
    return;
  }
  void task(project.editProposal ? '正在修改工程副本并复检…' : project.revision ? '正在布局布线并执行板规检查…' : '正在生成原理图并执行电气检查…', async () => {
    const result = await api(`/api/projects/${project.id}/confirm`, { revision: project.revision, proposalId: (project.editProposal || project.proposal)?.id || 'schematic' });
    page = result.stage; view = result.views.pcb ? 'pcb' : 'schematic';
    updateProject(result);
  });
});
$('explain').addEventListener('click', () => task('正在读取并解读本版本的检查报告…', async () => updateProject(await api(`/api/projects/${project.id}/explain`, { revision: project.revision, modelSelection: selectedModel() }))));
$('part-select').addEventListener('change', event => { part = event.target.value; renderInspector(); });
$('resistance-form').addEventListener('submit', event => {
  event.preventDefault();
  const resistance = Number($('resistance').value);
  void task('正在准备元件修改提案…', async () => updateProject(await api(`/api/projects/${project.id}/resistance`, { revision: project.revision, resistance })));
});
$('canvas').addEventListener('click', event => { const target = event.target.closest('[data-part]'); if (target) { part = target.dataset.part; renderInspector(); } });
$('canvas').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && event.target.dataset.part) { event.preventDefault(); part = event.target.dataset.part; renderInspector(); } });
$('zoom-in').addEventListener('click', () => zoom(1.25));
$('zoom-out').addEventListener('click', () => zoom(.8));
$('fit').addEventListener('click', () => { if (camera) { Object.assign(camera, camera.fit, { zoom: 1 }); applyCamera(); } });
$('grid').addEventListener('change', event => $('canvas').classList.toggle('no-grid', !event.target.checked));
for (const input of document.querySelectorAll('[data-layer]')) input.addEventListener('change', applyLayers);
let drag;
$('canvas').addEventListener('pointerdown', event => {
  if (!camera || event.button !== 0 || event.target.closest('[data-part]')) return;
  const matrix = camera.svg.getScreenCTM();
  drag = { x: event.clientX, y: event.clientY, viewX: camera.x, viewY: camera.y, scale: matrix.a };
  $('canvas').setPointerCapture(event.pointerId);
});
$('canvas').addEventListener('pointermove', event => {
  if (!camera) return;
  if (drag) { camera.x = drag.viewX - (event.clientX - drag.x) / drag.scale; camera.y = drag.viewY - (event.clientY - drag.y) / drag.scale; applyCamera(); }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(camera.svg.getScreenCTM().inverse());
  $('coordinates').textContent = `X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)}`;
});
$('canvas').addEventListener('lostpointercapture', () => { drag = null; });

for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('provider').addEventListener('change', () => {
  const apiMode = $('provider').value === 'api';
  $('api-fields').hidden = !apiMode;
  $('codex-hint').hidden = apiMode;
  for (const field of $('api-fields').querySelectorAll('input')) field.disabled = !apiMode;
  $('base-url').required = apiMode;
});
function openSettings() {
  if (!settings) return;
  $('provider').value = modelChoice?.provider || settings.provider;
  $('base-url').value = settings.baseUrl;
  $('model-name').value = settings.model;
  $('api-key').value = '';
  $('clear-api-key').checked = false;
  $('clear-key-field').hidden = !settings.hasApiKey;
  $('api-key').placeholder = settings.hasApiKey ? '已配置；留空保留，地址变化时需重新填写' : '选填';
  $('provider').dispatchEvent(new Event('change'));
  $('settings-dialog').showModal();
}
$('settings-button').addEventListener('click', openSettings);
function openApiSettings() {
  openSettings();
  $('provider').value = 'api';
  $('provider').dispatchEvent(new Event('change'));
}
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; $('clear-api-key').checked = false; });
$('chat-model').addEventListener('change', event => {
  if (event.target.value === 'configure') { renderModels(); openApiSettings(); return; }
  modelChoice = event.target.value === 'codex' ? { provider: 'codex' } : { provider: 'api', model: event.target.value.slice(4) };
  rememberModel(); render();
});
$('refresh-models').addEventListener('click', () => {
  if (!settings?.apiConfigured) { openApiSettings(); return; }
  void task('正在从 API 获取模型列表…', async () => applySettings(await api('/api/models', { connectionId: settings.connectionId }), false));
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  void task('正在应用模型设置…', async () => {
    const payload = { provider: $('provider').value, baseUrl: $('base-url').value, model: $('model-name').value, clearApiKey: $('clear-api-key').checked };
    if ($('api-key').value) payload.apiKey = $('api-key').value;
    applySettings(await api('/api/settings', payload));
    rememberModel();
    $('api-key').value = '';
    $('settings-dialog').close();
  });
});
$('import-project').addEventListener('click', () => { $('import-form').reset(); $('import-dialog').showModal(); });
$('import-form').addEventListener('submit', event => {
  event.preventDefault();
  const file = $('import-file').files[0];
  if (!file) return;
  void task('正在导回工程并重新检查…', async () => {
    if (file.size > 16 * 1024 * 1024) throw new Error('工程 ZIP 不能超过 16 MB。');
    const result = await api(`/api/import?name=${encodeURIComponent(file.name)}`, undefined, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
    page = 'pcb'; view = 'pcb'; part = '';
    updateProject(result);
    $('import-dialog').close();
  });
});

render();
try {
  const bootstrap = await api('/api/bootstrap');
  projects = bootstrap.projects;
  applySettings(bootstrap.settings);
  capability = bootstrap.capability;
  $('capability').textContent = `首版实做：${capability.voltage}V 红色 LED 指示板，支持 ${capability.resistanceMin}–${capability.resistanceMax} Ω 电阻。`;
  $('resistance').min = capability.resistanceMin;
  $('resistance').max = capability.resistanceMax;
  let previous;
  try {
    previous = localStorage.getItem('pcb-project');
    const savedModel = JSON.parse(localStorage.getItem('pcb-model') || 'null');
    if (savedModel?.provider === 'codex') modelChoice = { provider: 'codex' };
    else if (savedModel?.provider === 'api' && savedModel.baseUrl === settings.baseUrl && settings.apiConfigured && typeof savedModel.model === 'string' && savedModel.model.trim()) modelChoice = { provider: 'api', model: savedModel.model };
  } catch { /* Browser storage is optional. */ }
  if (projects.some(item => item.id === previous)) {
    project = await api(`/api/projects/${previous}`);
    page = project.stage; view = project.views?.pcb ? 'pcb' : 'schematic';
  }
  busy = false;
  render();
} catch (error) { notice(`工作台启动失败：${error.message}`, 'error', true); }
