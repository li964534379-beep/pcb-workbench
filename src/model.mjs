import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkReviewPrompt, checkReviewSchema, discussionPrompt, editSchema, planSchema, revisionPrompt, systemPrompt } from './prompts.mjs';

const run = promisify(execFile);
export function defaultModelSettings() {
  return process.env.PCB_MODEL_BASE_URL
    ? { provider: 'api', baseUrl: process.env.PCB_MODEL_BASE_URL, model: process.env.PCB_MODEL_NAME, apiKey: process.env.PCB_MODEL_API_KEY || '' }
    : { provider: 'codex' };
}

async function askApi(prompt, schema, settings) {
  const baseUrl = settings.baseUrl.replace(/\/$/, '');
  const model = settings.model;
  if (!model) throw new Error('请先选择模型，或在模型设置中填写默认模型名称。');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${prompt}\n输出 JSON 契约 ${JSON.stringify(schema)}` },
      ] }),
    });
  } catch {
    // Header validation exceptions can contain the Authorization value.
    throw new Error('模型接口连接失败，请检查 API 基础地址、网络和 Key 格式。');
  }
  if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
  const body = await response.json();
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'length' || choice?.message?.refusal || typeof choice?.message?.content !== 'string') {
    throw new Error('模型未返回完整的结构化结果。');
  }
  try {
    return JSON.parse(choice.message.content);
  } catch {
    throw new Error('模型没有返回可读取的 JSON。');
  }
}

let codexBinary;
async function locateCodex() {
  if (process.env.PCB_CODEX_EXE) return process.env.PCB_CODEX_EXE;
  if (process.platform !== 'win32') return 'codex';
  if (!codexBinary) {
    const { stdout } = await run('where.exe', ['codex.exe'], { windowsHide: true });
    codexBinary = stdout.trim().split(/\r?\n/)[0];
  }
  return codexBinary;
}

async function askCodex(prompt, schema, dataDirectory) {
  const dir = await mkdtemp(join(dataDirectory, 'model-'));
  const schemaFile = join(dir, 'schema.json');
  const resultFile = join(dir, 'answer.json');
  try {
    await writeFile(schemaFile, JSON.stringify(schema));
    const execution = run(await locateCodex(), [
      'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--cd', dir, '--output-schema', schemaFile, '--output-last-message', resultFile, '--color', 'never',
      '-',
    ], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const input = execution.child.stdin;
    input.on('error', () => {});
    input.end(`${systemPrompt}\n\n${prompt}`, 'utf8');
    await execution;
    return JSON.parse(await readFile(resultFile, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('本机模型没有返回可读取的 JSON。');
    throw new Error('本机 Codex 调用失败。请检查 Codex CLI 登录，或改用配置好的模型 API。');
  } finally {
    await Promise.allSettled([unlink(schemaFile), unlink(resultFile)]);
    await rmdir(dir).catch(() => {});
  }
}

function conforms(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  const accepted = [schema.type].flat();
  if (value === null) return accepted.includes('null');
  if (Array.isArray(value)) return accepted.includes('array') && value.every(element => conforms(element, schema.items));
  if (typeof value === 'object') {
    return accepted.includes('object') && Object.keys(value).length === schema.required.length && schema.required.every(key => conforms(value[key], schema.properties[key]));
  }
  if (typeof value === 'number') return accepted.includes('integer') && Number.isInteger(value);
  return accepted.includes('string') && typeof value === 'string' && !!value.trim() && value.length <= 2000;
}

async function ask(prompt, schema, dataDirectory, settings = defaultModelSettings()) {
  const result = settings.provider === 'api' ? await askApi(prompt, schema, settings) : await askCodex(prompt, schema, dataDirectory);
  if (!conforms(result, schema)) throw new Error('模型回复与当前阶段的结构化输出要求不符。');
  return result;
}

export async function discuss(messages, dataDirectory, settings) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 16 || messages.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000) || messages.at(-1).role !== 'user') {
    throw new Error('请填写一条设计需求。');
  }
  return ask(discussionPrompt(messages), planSchema, dataDirectory, settings);
}

export async function planChange(resistance, instruction, dataDirectory, settings, hasBoard = true) {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000) throw new Error('请描述想改哪里。');
  return ask(revisionPrompt(resistance, instruction, hasBoard), editSchema, dataDirectory, settings);
}

export function explainChecks(issues, dataDirectory, settings) {
  return ask(checkReviewPrompt(issues), checkReviewSchema, dataDirectory, settings);
}
