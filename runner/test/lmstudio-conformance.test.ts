import { runAdapterConformance } from './support/conformance.js';
import { createLmStudioTarget } from './support/fake-lmstudio.js';

runAdapterConformance('LM Studio adapter (native discovery)', () => createLmStudioTarget());
runAdapterConformance('LM Studio adapter (native chat profile)', () =>
  createLmStudioTarget({}, { chatProfile: 'native_v1' }),
);
