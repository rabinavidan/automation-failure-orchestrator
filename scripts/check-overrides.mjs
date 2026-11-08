#!/usr/bin/env node
/**
 * Reports which npm `overrides` in the root package.json are still needed.
 *
 * Overrides pin transitive packages to patched versions while upstream packages still depend on
 * vulnerable ranges. They should be removed as soon as upstream ships the fix, or they silently
 * keep forcing a major version nobody asked for. For each override this script resolves a fresh
 * dependency tree WITHOUT it (lockfile only, nothing installed, no scripts run), the tree a clean
 * install would get today, and compares `npm audit` with the same tree resolved WITH all
 * overrides:
 *
 *   still needed   removing it brings back an advisory for that package
 *   removable      the tree resolves to a safe version on its own: delete the override
 *
 *   node scripts/check-overrides.mjs              # human-readable report
 *   node scripts/check-overrides.mjs --markdown   # report for an issue / job summary
 *
 * Exit code: 0 when every override is still needed, 3 when at least one can be removed,
 * 1 on an error. Needs network access to the npm registry.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const markdown = process.argv.includes('--markdown');

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const overrides = rootPkg.overrides ?? {};

/** Workspace manifests are needed for npm to resolve the same tree as the real repository. */
function workspaceManifests() {
  const out = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, '');
    const dirs = pattern.endsWith('/*')
      ? execFileSync('ls', [join(ROOT, base)], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .map((d) => join(base, d))
      : [base];
    for (const dir of dirs) {
      if (existsSync(join(ROOT, dir, 'package.json'))) out.push(join(dir, 'package.json'));
    }
  }
  return out;
}

/** Packages that the npm advisory database reports as vulnerable in the resolved tree. */
function vulnerablePackages(dir) {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--json'], { cwd: dir, encoding: 'utf8' });
  } catch (err) {
    raw = err.stdout; // npm audit exits non-zero when it finds anything
  }
  return new Set(Object.keys(JSON.parse(raw).vulnerabilities ?? {}));
}

/**
 * Resolves a fresh lockfile (no existing lock, nothing installed, no scripts) for the given
 * overrides: the tree a clean install would get today. Returns the resolved packages and the
 * names `npm audit` flags in it.
 */
function resolve(withOverrides) {
  const dir = mkdtempSync(join(tmpdir(), 'override-check-'));
  try {
    for (const file of workspaceManifests()) {
      cpSync(join(ROOT, file), join(dir, file), { recursive: true });
    }
    const pkg = structuredClone(rootPkg);
    if (Object.keys(withOverrides).length) pkg.overrides = withOverrides;
    else delete pkg.overrides;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    execFileSync(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: dir, stdio: 'pipe' }
    );
    const packages = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages;
    return { packages, vulnerable: vulnerablePackages(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function versionsOf(packages, name) {
  return [
    ...new Set(
      Object.entries(packages)
        .filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
        .map(([, v]) => v.version)
    ),
  ];
}

function checkWithout(name, baseline) {
  const rest = { ...overrides };
  delete rest[name];
  const { packages, vulnerable } = resolve(rest);
  // Still needed if removing it flags anything the full set of overrides keeps clean.
  const flagged = [...vulnerable].filter((p) => !baseline.has(p));
  return { name, pinned: overrides[name], resolvesTo: versionsOf(packages, name), flagged };
}

const names = Object.keys(overrides);
if (names.length === 0) {
  console.log('No overrides in package.json.');
  process.exit(0);
}

try {
  const baseline = resolve(overrides).vulnerable;
  const results = names.map((name) => checkWithout(name, baseline));
  const removable = results.filter((r) => r.flagged.length === 0);

  if (markdown) {
    console.log('| Override | Pinned | Resolves to without it | Advisories without it | Verdict |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const r of results) {
      console.log(
        `| \`${r.name}\` | \`${r.pinned}\` | ${r.resolvesTo.join(', ') || 'not in tree'} | ` +
          `${r.flagged.join(', ') || 'none'} | ${r.flagged.length ? 'still needed' : '**removable**'} |`
      );
    }
  } else {
    for (const r of results) {
      const verdict = r.flagged.length
        ? `still needed (without it: ${r.flagged.join(', ')} flagged)`
        : 'REMOVABLE: upstream now resolves to a safe version';
      console.log(
        `${r.name.padEnd(16)} ${r.pinned.padEnd(10)} -> ${(r.resolvesTo.join(', ') || '-').padEnd(14)} ${verdict}`
      );
    }
  }
  process.exit(removable.length ? 3 : 0);
} catch (err) {
  console.error('override check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
