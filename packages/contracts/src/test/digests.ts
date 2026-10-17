/**
 * Independent digests of a test definition (BACKEND_PRD section 5.3).
 *
 * The manifest, the public fixture set, and the evaluator specification are
 * hashed separately, so a change to any one is visible on its own. The project
 * bundle digest comes from the project version and is not computed here.
 */

import { digestOf } from '../canonical.js';
import type { TestManifest } from './schema.js';

export interface TestDigests {
  manifest_digest: string;
  fixture_digest: string;
  evaluator_digest: string;
}

export function testDigests(manifest: TestManifest): TestDigests {
  return {
    manifest_digest: digestOf(manifest),
    fixture_digest: digestOf({
      fixture_kind: manifest.fixture_kind,
      fixture_license: manifest.fixture_license,
      response_schema: manifest.response_schema,
      cases: manifest.cases.map((testCase) => ({ key: testCase.key, messages: testCase.messages })),
    }),
    evaluator_digest: digestOf({
      cases: manifest.cases.map((testCase) => ({ key: testCase.key, evaluation: testCase.evaluation })),
    }),
  };
}
