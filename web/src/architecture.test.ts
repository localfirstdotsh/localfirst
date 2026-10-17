import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS } from './design-system/breakpoints';

const root = import.meta.dirname;
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}
const files = filesIn(root);
const name = (path: string) => relative(root, path);

function imports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  if (extname(file) === '.css') return [...source.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  const found: string[] = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

function resolveImport(file: string, specifier: string): string | undefined {
  const path = resolve(dirname(file), specifier);
  return [path, `${path}.ts`, `${path}.tsx`, resolve(path, 'index.ts')].find((candidate) => existsSync(candidate) && files.includes(candidate));
}

function violation(from: string, to: string): string | undefined {
  if (from.startsWith('components/') && /^(features|app)\//.test(to)) return 'Shared components cannot depend on routes or features';
  if (from.startsWith('components/ui/') && to.startsWith('components/') && !to.startsWith('components/ui/')) return 'UI primitives cannot depend on composites or layouts';
  if (/^(lib|design-system)\//.test(from) && /^(features|app|components)\//.test(to)) return 'Infrastructure and tokens cannot depend on UI or features';
  if (from.startsWith('features/') && to.startsWith('app/')) return 'Features cannot depend on routes';
  const sourceFeature = from.match(/^features\/([^/]+)\//)?.[1];
  const targetFeature = to.match(/^features\/([^/]+)\//)?.[1];
  if (sourceFeature && targetFeature && sourceFeature !== targetFeature && to !== `features/${targetFeature}/index.ts`) return 'Cross-feature imports must use an explicit public index';
}

function cycles(graph: Map<string, string[]>): string[] {
  const active: string[] = [];
  const done = new Set<string>();
  const found: string[] = [];
  function visit(file: string) {
    const index = active.indexOf(file);
    if (index >= 0) { found.push([...active.slice(index), file].join(' -> ')); return; }
    if (done.has(file)) return;
    active.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.pop();
    done.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return found;
}

const graph = new Map<string, string[]>();
const failures: string[] = [];
for (const file of files) {
  const edges: string[] = [];
  for (const specifier of imports(file)) {
    if (!specifier.startsWith('.')) {
      // This package has no aliases. Refuse opaque local aliases rather than silently skipping boundary checks.
      if (specifier.startsWith('@/') || specifier.startsWith('~/')) failures.push(`${name(file)}: unsupported alias ${specifier}`);
      continue;
    }
    const target = resolveImport(file, specifier);
    if (!target) { failures.push(`${name(file)}: unresolved ${specifier}`); continue; }
    edges.push(name(target));
    const error = violation(name(file), name(target));
    if (error) failures.push(`${name(file)} -> ${name(target)}: ${error}`);
  }
  graph.set(name(file), edges);
}

describe('frontend architecture', () => {
  it('resolves imports and enforces ownership across TypeScript and CSS', () => { expect(failures).toEqual([]); });
  it('has no circular local dependencies, including type imports and public exports', () => { expect(cycles(graph)).toEqual([]); });
  it('rejects reversed and private cross-feature dependencies', () => {
    for (const [from, to] of [
      ['components/ui/Button.tsx', 'features/projects/check-action.ts'],
      ['components/ui/Button.tsx', 'components/composites/StatePanel.tsx'],
      ['lib/api.ts', 'features/catalog/CatalogResults.tsx'],
      ['features/projects/CheckRequirements.tsx', 'app/projects/page.tsx'],
      ['features/catalog/ProjectRow.tsx', 'features/projects/EvidenceBadge.tsx'],
    ]) expect(violation(from!, to!)).toBeTruthy();
    expect(violation('features/catalog/ProjectRow.tsx', 'features/projects/index.ts')).toBeUndefined();
    expect(cycles(new Map([['a', ['b']], ['b', ['a']]]))).toEqual(['a -> b -> a']);
  });
  it('keeps responsive CSS aligned with JavaScript media queries', () => {
    expect(readFileSync(resolve(root, 'app/styles/patterns.css'), 'utf8')).toContain(`@media (max-width: ${BREAKPOINTS.phone - 1}px)`);
    expect(readFileSync(resolve(root, 'features/catalog/filters.css'), 'utf8')).toContain(`@media (max-width: ${BREAKPOINTS.catalog - 1}px)`);
  });
  it('keeps visual values in CSS and feature exports explicit', () => {
    for (const file of files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx') && !f.endsWith('.css'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, name(file)).not.toMatch(/style=\{\{/);
      expect(source, name(file)).not.toMatch(/export\s+\*\s+from/);
    }
  });
});
