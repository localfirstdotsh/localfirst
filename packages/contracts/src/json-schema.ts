/**
 * Public JSON Schema documents served from `/schemas/...` (section 12.3).
 * Generated from the same Zod definitions the API validates with, so the
 * published contract cannot drift from enforcement.
 */

import { z } from 'zod';
import { projectSpecV2Schema, projectSpecV3Schema } from './project/schema.js';
import { environmentSchema, workflowTestSchema } from './environment/schema.js';
import { workflowBuildInputSchema, workflowResultSchema } from './environment/shared.js';
import { testManifestSchema } from './test/schema.js';
import { buildReportSchema } from './build/report.js';
import { buildInputSchema } from './build/schema.js';
import { testResultSchema } from './result/schema.js';
import {
  BUILD_REPORT_SCHEMA_ID,
  BUILD_SCHEMA_ID,
  SPEC_SCHEMA_ID,
  TEST_RESULT_SCHEMA_ID,
  TEST_SCHEMA_ID,
} from './vocabulary.js';

function build(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    ...generated,
  };
}

export function environmentJsonSchemas(baseUrl: string): Record<string, Record<string, unknown>> {
  return Object.fromEntries([
    ['project/v0.3', projectSpecV3Schema], ['environment/v0.1', environmentSchema],
    ['test/v0.2', workflowTestSchema], ['build/v0.2', workflowBuildInputSchema], ['test-result/v0.2', workflowResultSchema],
  ].map(([name, schema]) => [name as string, build(schema as z.ZodType, baseUrl + '/schemas/' + name + '.json', 'Localfirst ' + name)]));
}

export function projectJsonSchema(baseUrl: string): Record<string, unknown> {
  return build(
    projectSpecV2Schema,
    `${baseUrl}/schemas/project/v0.2.json`,
    `Localfirst portable project specification (${SPEC_SCHEMA_ID})`,
  );
}

export function testJsonSchema(baseUrl: string): Record<string, unknown> {
  return build(
    testManifestSchema,
    `${baseUrl}/schemas/test/v0.1.json`,
    `Localfirst declarative task test manifest (${TEST_SCHEMA_ID})`,
  );
}

export function buildJsonSchema(baseUrl: string): Record<string, unknown> {
  return build(
    buildInputSchema,
    `${baseUrl}/schemas/build/v0.1.json`,
    `Localfirst saved build, client input (${BUILD_SCHEMA_ID})`,
  );
}

export function buildReportJsonSchema(baseUrl: string): Record<string, unknown> {
  return build(
    buildReportSchema,
    `${baseUrl}/schemas/build-report/v0.1.json`,
    `Localfirst manual build report (${BUILD_REPORT_SCHEMA_ID})`,
  );
}

export function testResultJsonSchema(baseUrl: string): Record<string, unknown> {
  return build(
    testResultSchema,
    `${baseUrl}/schemas/test-result/v0.1.json`,
    `Localfirst sanitized test result (${TEST_RESULT_SCHEMA_ID})`,
  );
}
