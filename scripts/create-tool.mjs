import fs from 'node:fs';
import path from 'node:path';

import { RESERVED_NAMES, TEMPLATE_DIR, TOOLS_ROOT, TOOL_ID_PATTERN, parseArgs, readJson } from './lib.mjs';

/**
 * Creates a new tool from template/: `npm run create-tool -- <id> [Название]`.
 * The id becomes the folder name, the manifest id and the URL path (/<id>/<version>/).
 */

const options = parseArgs();
const [id, ...titleWords] = options._;
const title = titleWords.join(' ').trim() || id;

function fail(message) {
  console.error(`create-tool: ${message}`);
  process.exit(1);
}

if (!id) {
  fail('укажите id: npm run create-tool -- my-tool "Мой инструмент"');
}
if (!TOOL_ID_PATTERN.test(id)) {
  fail(`id "${id}" — только латиница в нижнем регистре, цифры и дефис, начинается с буквы или цифры`);
}
if (RESERVED_NAMES.has(id) || id === 'template') {
  fail(`id "${id}" занят служебной папкой`);
}
const target = path.join(TOOLS_ROOT, id);
if (fs.existsSync(target)) {
  fail(`папка ${id}/ уже существует`);
}

fs.cpSync(TEMPLATE_DIR, target, {
  recursive: true,
  filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source),
});

const manifestPath = path.join(target, 'tool.manifest.json');
const manifest = readJson(manifestPath);
manifest.id = id;
manifest.version = '0.1.0';
manifest.title = title.slice(0, 60);
manifest.description = 'Опишите инструмент в одном-двух предложениях';
manifest.storageSchemaVersion = 1;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const htmlPath = path.join(target, 'index.html');
fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace(/<title>.*<\/title>/, `<title>${manifest.title} — TtRP</title>`));

console.log(`create-tool: создан ${id}/ из шаблона`);
console.log('Дальше:');
console.log('  1. npm run dev — песочница на http://localhost:5180, выберите инструмент слева');
console.log(`  2. правьте ${id}/src/, состояние и его схему — в ${id}/src/state.ts`);
console.log('  3. перед отправкой: npm run check и чек-лист из docs/connecting.md');
