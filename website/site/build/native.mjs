import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  root = resolve(site, '..');
const args = process.argv.slice(2);
for (const arg of args)
  if (!['--check', '--shared', '--cpu'].includes(arg)) throw Error('Unknown native build option ' + arg);
const cpu = args.includes('--cpu'),
  shared = args.includes('--shared'),
  check = args.includes('--check');
if (cpu && shared) throw Error('Render CPU memory is ordinary; no shared CPU artifact');
const name = cpu ? 'cpu-utils' : 'tile-data',
  prefix = resolve(root, '.wasm-tools/llvm/usr');
const compiler = process.env.ZIZAI_CLANG || join(prefix, 'bin/clang++-18'),
  linker = process.env.ZIZAI_WASM_LD || join(prefix, 'bin/wasm-ld-18');
const target = join(site, 'assets/wasm', name + (shared ? '.shared' : '') + '.wasm');
const temporary = mkdtempSync(join(tmpdir(), 'zizai-native-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (!existsSync(compiler)) throw Error('Set ZIZAI_CLANG and ZIZAI_WASM_LD to a local clang/wasm-ld toolchain');
  const out = join(temporary, name + '.wasm'),
    initial = cpu ? 4194304 : 16777216,
    maximum = cpu ? 4194304 : 33554432;
  const flags = [
    '--target=wasm32',
    '-std=c++17',
    '-O3',
    '-msimd128',
    '-ffp-contract=off',
    '-fno-exceptions',
    '-fno-rtti',
    '-fno-builtin',
    '-nostdlib',
    '-fuse-ld=' + linker,
    '-Wdouble-promotion',
    '-Werror=double-promotion',
    ...(shared ? ['-matomics', '-mbulk-memory', '-Wl,--shared-memory'] : []),
    '-Wl,--no-entry',
    '-Wl,--strip-all',
    '-Wl,--initial-memory=' + initial,
    '-Wl,--max-memory=' + maximum,
    '-Wl,-z,stack-size=65536',
  ];
  const run = extra =>
    execFileSync(compiler, [...flags, ...extra], {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [join(prefix, 'lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
      stdio: 'pipe',
    });
  const object = join(temporary, name + '.o');
  run(['-c', join(site, 'src/native', name + '.cpp'), '-o', object]);
  run([object, '-Wl,--export-all', '-o', out]);
  const scripts = [];
  (function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) scripts.push(readFileSync(path, 'utf8'));
    }
  })(join(site, 'src'));
  for (const entry of readdirSync(join(site, 'tests')))
    if (/\.(?:js|mjs|cjs)$/.test(entry)) scripts.push(readFileSync(join(site, 'tests', entry), 'utf8'));
  const words = new Set(scripts.join('\n').match(/[A-Za-z_$][A-Za-z0-9_$]*/g));
  const exported = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(out)))
    .filter(item => item.kind === 'function' && words.has(item.name))
    .map(item => item.name);
  if (!exported.length) throw Error('No native function is named by the page');
  run([object, ...exported.map(item => '-Wl,--export=' + item), '-Wl,--export=__heap_base', '-o', out]);
  const wat = execFileSync('wasm2wat', [...(shared ? ['--enable-threads'] : []), out], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (/\bf64(?:x2)?(?:[.\s)])/.test(wat)) throw Error('Double instruction/type found in float32 source core');
  const simd = (wat.match(/\bf32x4\./g) || []).length;
  if (!simd) throw Error('Explicit f32x4 SIMD missing');
  const bytes = readFileSync(out),
    module = new WebAssembly.Module(bytes),
    imports = WebAssembly.Module.imports(module);
  if (imports.length) throw Error('Unexpected runtime imports: ' + JSON.stringify(imports));
  const inputs = {};
  function inspect(path) {
    const relative = path.slice(site.length + 1),
      content = readFileSync(path);
    if (inputs[relative]) return;
    inputs[relative] = { bytes: content.length, sha256: hash(content) };
    for (const include of content.toString('utf8').matchAll(/^#include \"([^\"]+)\"/gm))
      inspect(resolve(dirname(path), include[1]));
  }
  inspect(join(site, 'src/native', name + '.cpp'));
  if (check) {
    if (!readFileSync(target).equals(bytes)) throw Error('Native binary asset is stale: ' + target);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  console.log(
    JSON.stringify({
      passed: true,
      target: target.slice(root.length + 1),
      bytes: bytes.length,
      sha256: hash(bytes),
      imports: 0,
      f64Instructions: 0,
      f32x4Instructions: simd,
      initialMemoryMiB: initial / 1048576,
      maxMemoryMiB: maximum / 1048576,
      shared,
      checked: check,
      sources: inputs,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
