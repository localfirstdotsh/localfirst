/**
 * Generates `src/db/schema/auth.ts` from Better Auth's own table specification
 * (`getSchema`), so the reviewed Drizzle schema cannot drift from the auth
 * library's expectations (BACKEND_PRD section 16.1, 16.4).
 *
 * Run `pnpm --filter @localfirst/backend db:auth-schema` after changing auth
 * plugins or versions, then review the generated file and the migration.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSchema } from 'better-auth/db';
import type { DBFieldAttribute } from '@better-auth/core/db';
import { buildAuthOptions } from '../src/auth/options.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://generator/unused',
  API_BASE_URL: 'https://api.localfirst.sh',
  WEBSITE_URL: 'https://localfirst.sh',
  AUTH_SECRET: 'generator-placeholder-secret-value-0000000',
  NODE_ENV: 'development',
  // Generate the widest schema so a later phase flip needs no new migration.
  FEATURE_TEST_DEFINITIONS: 'true',
  FEATURE_RESULT_SUBMISSION: 'true',
});

const schema = getSchema(buildAuthOptions({ config }));

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function columnFor(name: string, field: DBFieldAttribute): string {
  const column = `'${name}'`;
  const type = field.type;
  let base: string;
  if (Array.isArray(type)) {
    base = `text(${column})`;
  } else {
    switch (type) {
      case 'string':
        base = `text(${column})`;
        break;
      case 'number':
        base = field.bigint ? `bigint(${column}, { mode: 'number' })` : `integer(${column})`;
        break;
      case 'boolean':
        base = `boolean(${column})`;
        break;
      case 'date':
        base = `timestamp(${column}, { withTimezone: true, mode: 'date' })`;
        break;
      case 'json':
        base = `jsonb(${column})`;
        break;
      case 'string[]':
      case 'number[]':
        base = `jsonb(${column})`;
        break;
      default:
        base = `text(${column})`;
    }
  }
  const parts = [base];
  if (name === 'id') parts.push('primaryKey()');
  if (field.required !== false && name !== 'id') parts.push('notNull()');
  if (field.unique) parts.push('unique()');
  if (field.references) {
    const target = tableConst(field.references.model);
    parts.push(
      `references(() => ${target}.${field.references.field}, { onDelete: '${field.references.onDelete ?? 'cascade'}' })`,
    );
  }
  return `  ${name}: ${parts.join('.')},`;
}

function tableConst(model: string): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}Table`;
}

const ordered = Object.entries(schema).sort((a, b) => a[1].order - b[1].order);

const imports = new Set<string>(['pgTable']);
for (const [, table] of ordered) {
  for (const index of table.indexes ?? []) imports.add(index.unique ? 'uniqueIndex' : 'index');
}
for (const [, table] of ordered) {
  for (const field of Object.values(table.fields)) {
    const type = field.type;
    if (Array.isArray(type) || type === 'string' || type === 'string[]') imports.add('text');
    if (type === 'number') imports.add(field.bigint ? 'bigint' : 'integer');
    if (type === 'boolean') imports.add('boolean');
    if (type === 'date') imports.add('timestamp');
    if (type === 'json' || type === 'string[]' || type === 'number[]') imports.add('jsonb');
  }
}

const lines: string[] = [
  '/**',
  ' * GENERATED FILE — do not edit by hand.',
  ' *',
  " * Mirrors Better Auth's own table specification for the configured plugins",
  ' * (GitHub sign-in, JWT signing keys, and the MCP/OAuth provider). Regenerate',
  ' * with `pnpm db:auth-schema` after an auth dependency or plugin change, then',
  ' * review the generated SQL migration.',
  ' *',
  ` * Generated from: better-auth ${process.env.BETTER_AUTH_VERSION ?? 'pinned release'}`,
  ' */',
  '',
  `import { ${[...imports].sort().join(', ')} } from 'drizzle-orm/pg-core';`,
  '',
];

for (const [model, table] of ordered) {
  const columns = Object.entries(table.fields)
    .map(([name, field]) => columnFor(field.fieldName ?? name, field))
    .join('\n');
  const indexes = (table.indexes ?? []).map((index) => {
    const builder = index.unique ? 'uniqueIndex' : 'index';
    const columnList = index.columns.map((column) => `columns.${column}`).join(', ');
    return `    ${builder}('${index.name}').on(${columnList}),`;
  });
  lines.push(`export const ${tableConst(model)} = pgTable(`);
  lines.push(`  '${camelToSnake(model)}',`);
  lines.push('  {');
  lines.push(`    id: text('id').primaryKey(),`);
  lines.push(columns.replace(/^ {2}/gm, '    '));
  lines.push('  },');
  if (indexes.length > 0) {
    lines.push('  (columns) => [');
    lines.push(...indexes);
    lines.push('  ],');
  }
  lines.push(');');
  lines.push('');
}

lines.push('/** Table names Better Auth owns, for schema-drift assertions in tests. */');
lines.push(
  `export const AUTH_MODELS = ${JSON.stringify(ordered.map(([model]) => model))} as const;`,
);
lines.push('');
lines.push('/** Model-name keyed map handed to the Better Auth Drizzle adapter. */');
lines.push('export const AUTH_SCHEMA = {');
for (const [model] of ordered) {
  lines.push(`  ${model}: ${tableConst(model)},`);
}
lines.push('} as const;');
lines.push('');

const target = join(import.meta.dirname, '..', 'src', 'db', 'schema', 'auth.ts');
writeFileSync(target, lines.join('\n'), 'utf8');
console.log(`wrote ${target} (${ordered.length} tables)`);
for (const [model, table] of ordered) {
  console.log(`  ${model}: ${Object.keys(table.fields).length + 1} columns`);
}
