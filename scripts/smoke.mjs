/**
 * Headless test runner.
 *
 * The game logic (physics, city generation, AI, vehicle handling) is deliberately free of
 * WebGL calls, so it can be executed in plain Node with a stubbed <canvas>. This script
 * compiles the game modules to ESM, then runs every test in tests/.
 *
 *   npm test
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.smoke-build';
const MODULES = [
  'mathx', 'settings', 'physics', 'assets', 'materials', 'sky', 'theme', 'maps', 'city', 'humanoid', 'characters',
  'weapons', 'vehicle', 'peds', 'traffic', 'combat', 'minimap', 'hudstore',
  'camerarig', 'audio', 'input', 'water', 'ao', 'layout', 'scheme', 'protocol', 'netclient',
  'weather', 'police', 'jobs', 'device', 'touchinput', 'touchlayout', 'wanted',
];

// A file lock (antivirus, an editor, a stray node) can make the build directory
// undeletable on Windows. Every file we need is rewritten below, so warn and carry on
// rather than dying on a raw EPERM before a single test has run.
try {
  rmSync(OUT, { recursive: true, force: true });
} catch {
  console.warn(`could not clear ${OUT} (locked) - reusing it; stale files are overwritten`);
}
mkdirSync(OUT, { recursive: true });

console.log('compiling game modules…');
execFileSync(
  process.execPath,
  [
    join('node_modules', 'typescript', 'bin', 'tsc'),
    ...MODULES.map((m) => `game/${m}.ts`),
    '--outDir', OUT,
    '--module', 'esnext',
    '--moduleResolution', 'bundler',
    '--target', 'es2022',
    '--skipLibCheck',
    '--strict', 'false',
  ],
  { stdio: 'inherit' },
);

// Node needs explicit extensions on relative ESM imports; tsc does not add them.
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.js'))) {
  const p = join(OUT, f);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[\w-]+)'/g, "from '$1.js'"));
}
writeFileSync(join(OUT, 'package.json'), '{ "type": "module" }');

// Written rather than copied: cpSync unlinks the destination first, which fails on a
// locked-but-writable file. Overwriting in place works either way.
for (const f of readdirSync('tests').filter((f) => f.endsWith('.mjs'))) {
  writeFileSync(join(OUT, f), readFileSync(join('tests', f)));
}

let failed = 0;
// every .mjs in tests/ is copied (so suites can import shared helpers), but only
// *.test.mjs files are executed as suites
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.test.mjs'))) {
  console.log(`\n=== ${f} ===`);
  try {
    execFileSync(process.execPath, [join(OUT, f)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
process.exit(failed ? 1 : 0);
