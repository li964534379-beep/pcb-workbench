import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { workbenchClient } from './src/client.mjs';
import { buildConfirmedSchematic, discussDesign, explainKiCadReports, proposeKiCadEdit, routeConfirmedSchematic } from './src/workflow.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const [command, input, argument, confirmation, ...extra] = process.argv.slice(2);
const usage = '用法\n  node cli.mjs discuss <对话.json>\n  node cli.mjs schematic <草案.json> <新目录> --confirm\n  node cli.mjs route <工程目录> --confirm\n  node cli.mjs propose-kicad-edit <工程目录> "改动要求"\n  node cli.mjs explain-checks <工程目录>';

async function modelDirectory(path) {
  const data = resolve(process.env.PCB_WORKBENCH_DATA || dirname(resolve(path)));
  await mkdir(data, { recursive: true });
  return data;
}

try {
  let result;
  if (command === 'app') {
    result = await workbenchClient(process.argv.slice(3));
  } else if (!input || extra.length) {
    throw new Error(usage);
  } else if (command === 'discuss' && !argument) {
    result = await discussDesign(await readJson(input), await modelDirectory(input));
  } else if (command === 'schematic' && argument) {
    result = await buildConfirmedSchematic(await readJson(input), argument, confirmation === '--confirm');
  } else if (command === 'route' && !confirmation) {
    result = await routeConfirmedSchematic(input, argument === '--confirm');
  } else if (command === 'propose-kicad-edit' && argument && !confirmation) {
    result = await proposeKiCadEdit(input, argument, await modelDirectory(input));
  } else if (command === 'explain-checks' && !argument) {
    result = await explainKiCadReports(input, await modelDirectory(input));
  } else {
    throw new Error(usage);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'issues') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
