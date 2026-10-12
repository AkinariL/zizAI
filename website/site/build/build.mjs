import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { minify } = require('terser');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2),
  options = { debug: false, minify: true, out: join(root, 'dist'), fallbackURL: null };
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (key === '--debug') options.debug = true;
  else if (key === '--no-minify') options.minify = false;
  else if (key === '--out') options.out = resolve(args[++index]);
  else if (key === '--fallback-url') options.fallbackURL = args[++index];
  else throw Error('Unknown build option ' + key);
}
const read = path => readFileSync(join(root, path), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = new Map();
function source(path) {
  const text = read(path);
  sources.set(path, { bytes: Buffer.byteLength(text), sha256: sha(text) });
  return text;
}
const debugOnly = new Set(['src/main/debug-bindings.js', 'src/main/probe.js', 'tests/capture-bridge.js']);
function ordered(folder) {
  const list = JSON.parse(read(join('src', folder, 'order.json'))).map(path =>
    relative(root, resolve(root, 'src', folder, path)),
  );
  return list
    .filter(path => options.debug || !debugOnly.has(path))
    .map(path => source(path))
    .join('\n');
}
const declareDebug = options.minify ? '' : 'const SITE_DEBUG=' + options.debug + ';\n';
async function compress(code) {
  if (!options.minify) return code;
  const result = await minify(code, {
    compress: { passes: 2, unsafe: false, global_defs: { SITE_DEBUG: options.debug } },
    mangle: !options.debug,
    format: { comments: false },
  });
  if (result.error) throw result.error;
  return result.code;
}
const nativeLoader = source('src/shared/native-assets.js');
const render = await compress(
  declareDebug +
    nativeLoader +
    '\n' +
    source('src/render/bootstrap-head.js') +
    '\n' +
    ordered('render') +
    '\n' +
    source('src/render/bootstrap-tail.js'),
);
const generate = await compress(
  declareDebug +
    nativeLoader +
    '\n' +
    source('src/generate/bootstrap-head.js') +
    '\n' +
    ordered('generate') +
    '\n' +
    source('src/generate/bootstrap-tail.js'),
);
const main = await compress('(() => {\n' + declareDebug + ordered('main') + '\n})();');
const delivery = await compress(source('src/shared/delivery.js'));
const entry = await compress(source('src/main/entry.js'));
const probe = await compress(source('src/main/probe-worker.js'));
const fontManifest = JSON.parse(read('assets/font-manifest.json'));
const outputs = [];
function save(path, bytes) {
  const target = join(options.out, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  outputs.push({
    path,
    bytes: Buffer.byteLength(bytes),
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    sha256: sha(bytes),
  });
}
function binary(path) {
  return readFileSync(join(root, path));
}
function config(profile, single = false) {
  const fontConfig = JSON.parse(JSON.stringify(fontManifest));
  for (const resource of fontConfig.resources) {
    if (single) {
      resource.base64 = binary(resource.url).toString('base64');
      delete resource.url;
    }
  }
  const asset = (path, variant) =>
    single ? { base64: binary(path).toString('base64'), variant } : { url: path, variant };
  return {
    profile,
    debug: options.debug,
    fallbackURL: options.fallbackURL,
    workers: single
      ? {
          render: { base64: Buffer.from(render).toString('base64') },
          generate: { base64: Buffer.from(generate).toString('base64') },
        }
      : { render: 'render.worker.js', generate: 'generate.worker.js' },
    assets: {
      wasm: {
        cpu: asset('assets/wasm/cpu-utils.wasm', 'ordinary'),
        tile: asset(profile === 'shared' ? 'assets/wasm/tile-data.shared.wasm' : 'assets/wasm/tile-data.wasm', profile),
        ...(profile === 'shared' ? { tileOrdinary: asset('assets/wasm/tile-data.wasm', 'ordinary') } : {}),
      },
      fonts: fontConfig,
    },
  };
}
function script(text) {
  if (/<\/script/i.test(text)) throw Error('A literal closing script tag requires an explicit resource encoding');
  return '<script>\n' + text + '\n</script>\n';
}
function html(configuration, mainTag) {
  const page = source('src/html/page.html');
  const slots = [
    ['<!-- SITE_STYLE -->', source('src/html/base.css') + '\n' + source('src/html/style.css')],
    ['<!-- SITE_BODY -->', source('src/html/body.html')],
    ['<!-- SITE_CONFIG -->', script('globalThis.SITE_CONFIG=' + JSON.stringify(configuration) + ';\n' + delivery)],
    ['<!-- SITE_MAIN -->', mainTag],
  ];
  let result = '',
    cursor = 0;
  for (const [marker, content] of slots) {
    const at = page.indexOf(marker, cursor);
    if (at < 0 || page.indexOf(marker, at + marker.length) >= 0) throw Error('Invalid page template slot ' + marker);
    result += page.slice(cursor, at) + content;
    cursor = at + marker.length;
  }
  return result + page.slice(cursor);
}
mkdirSync(options.out, { recursive: true });
for (const profile of ['shared', 'ordinary']) {
  save(profile + '/index.html', html(config(profile), '<script src="main.js"></script>\n'));
  save(profile + '/main.js', main);
  save(profile + '/render.worker.js', render);
  save(profile + '/generate.worker.js', generate);
  for (const path of [
    'assets/wasm/cpu-utils.wasm',
    profile === 'shared' ? 'assets/wasm/tile-data.shared.wasm' : 'assets/wasm/tile-data.wasm',
    ...fontManifest.resources.map(resource => resource.url),
  ])
    save(profile + '/' + path, binary(path));
  if (profile === 'shared') save(profile + '/assets/wasm/tile-data.wasm', binary('assets/wasm/tile-data.wasm'));
}
save('single.html', html(config('ordinary', true), script(main)));
save('probe.worker.js', probe);
const entryConfiguration = {
  probeURL: 'probe.worker.js',
  packages: { shared: 'shared/index.html', ordinary: 'ordinary/index.html' },
  fallbackURL: options.fallbackURL,
};
save(
  'index.html',
  '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>字在</title><body>' +
    script('globalThis.SITE_ENTRY_CONFIG=' + JSON.stringify(entryConfiguration) + ';\n' + entry) +
    '</body></html>',
);
save(
  'headers.json',
  JSON.stringify(
    {
      entry: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
      shared: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
      ordinary: {},
      wasmMIME: 'application/wasm',
    },
    null,
    2,
  ) + '\n',
);
const manifest = {
  schema: 1,
  debug: options.debug,
  minified: options.minify,
  baselineSHA256: '236392ad7719e17dcced58d5ef35288faef803ee1928508b1b38117c8c98a009',
  sources: Object.fromEntries(sources),
  outputs,
  profiles: {
    shared: { generationWorkers: 1, resultRegions: 2, tileMemory: 'shared', renderCPUMemory: 'ordinary' },
    ordinary: { generationWorkers: 1, resultRegions: 1, tileMemory: 'ordinary', renderCPUMemory: 'ordinary' },
    single: { generationWorkers: 1, resultRegions: 1, tileMemory: 'ordinary', renderCPUMemory: 'ordinary' },
  },
};
writeFileSync(join(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  JSON.stringify({
    out: options.out,
    debug: options.debug,
    sourceFiles: sources.size,
    singleBytes: outputs.find(item => item.path === 'single.html').bytes,
    outputs: outputs.length,
  }),
);
