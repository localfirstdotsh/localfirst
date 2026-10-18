/**
 * Seed catalog (BACKEND_PRD sections 15.4, 21).
 *
 * Five curated Jetson/edge entries plus one documentation-only hardware entry
 * and the reference declarative-task fixture. Curated listings record
 * `curated_from_upstream`, their original authors, exact sources and license
 * state, documented software stack, explicit unknowns, and honest test support.
 *
 * Selecting a source does not claim it works on every Jetson, that its authors
 * submitted it, or that NVIDIA endorses Localfirst. Nothing here has been run
 * by Localfirst, so no entry carries a test result.
 */

import {
  EXAMPLE_PROJECT_MD,
  EXAMPLE_TEST_PATH,
  EXAMPLE_TEST_YAML,
  serializeProjectDocument,
  SPEC_SCHEMA_ID,
} from '@localfirst/contracts';

export interface SeedProject {
  /** Which seeded account submits it. */
  submitter: 'curator' | 'builder';
  frontmatter: Record<string, unknown>;
  markdown: string;
  files?: Array<{ path: string; content: string }>;
}

const UNKNOWN_MODELS = { state: 'unknown', roles: [] } as const;
const NO_DEPENDENCIES_DECLARED = { state: 'unknown', items: [] } as const;

function curatedAttribution(
  authors: Array<{ name: string; url: string | null }>,
): Record<string, unknown> {
  return { authors, relationship: 'curator_submitted' };
}

/** 1 — Jetson AI Lab tutorials (documentation only). */
const jetsonAiLab: SeedProject = {
  submitter: 'curator',
  frontmatter: {
    schema: SPEC_SCHEMA_ID,
    project: {
      key: 'jetson-ai-lab-tutorials',
      name: 'Jetson AI Lab tutorials',
      summary:
        'Curated reference to NVIDIA Jetson AI Lab device-oriented AI tutorials and their contribution guidance.',
      type: 'documentation',
      categories: ['documentation', 'hardware-setup'],
      version: '0.1.0',
      license: { state: 'unknown', id: null, reference: null },
    },
    sources: [
      {
        key: 'upstream-repository',
        kind: 'repository',
        url: 'https://github.com/NVIDIA-AI-IOT/jetson-ai-lab',
        revision: null,
        content_digest: null,
        path: null,
        license: { state: 'unknown', id: null, reference: null },
        note: 'Upstream repository. Check the specific tutorial and its license before reuse.',
      },
      {
        key: 'contribution-guide',
        kind: 'documentation',
        url: 'https://github.com/NVIDIA-AI-IOT/jetson-ai-lab/blob/main/CONTRIBUTING.md',
        revision: null,
        content_digest: null,
        path: null,
        license: null,
        note: 'Upstream contribution guidance.',
      },
    ],
    attribution: curatedAttribution([
      { name: 'NVIDIA AI IOT contributors', url: 'https://github.com/NVIDIA-AI-IOT' },
    ]),
    models: UNKNOWN_MODELS,
    runtimes: { state: 'unknown', supported: [] },
    hardware: {
      state: 'declared',
      architectures: ['arm64'],
      minimum_memory_bytes: null,
      minimum_vram_bytes: null,
      accelerator: 'required',
      devices: ['NVIDIA Jetson developer kits'],
    },
    operating_systems: { state: 'declared', supported: ['linux'] },
    dependencies: NO_DEPENDENCIES_DECLARED,
    configurations: [
      {
        key: 'reading-only',
        model_roles: [],
        setup_kind: 'unsupported',
        workload: { context_tokens: null, concurrency: null },
        note: 'This listing points at upstream documentation; it installs and runs nothing.',
      },
    ],
    data_boundary: {
      inference: 'unknown',
      storage: 'unknown',
      runtime_network: 'unknown',
      external_services: [],
    },
    test_support: 'none',
    tests: [],
    limitations: [
      'This is a curated pointer to upstream documentation, not a runnable project.',
      'Individual tutorials target specific Jetson devices and JetPack versions; neither is resolved here.',
      'Licensing varies per tutorial and asset and is recorded as unknown.',
      'No Localfirst test has been run, and NVIDIA has not endorsed this listing.',
    ],
    evidence: [
      {
        kind: 'documented',
        summary: 'The upstream repository publishes device-oriented tutorials and contribution guidance.',
        reference: 'https://github.com/NVIDIA-AI-IOT/jetson-ai-lab',
      },
    ],
    media: [],
    derivative_of: null,
  },
  markdown: `## Purpose

Point builders at NVIDIA's Jetson AI Lab tutorials from inside Localfirst, with
honest metadata about what is and is not established. The entry exists so that
Jetson material is discoverable alongside other local-AI projects.

## Architecture and workflow

No architecture of its own: each upstream tutorial defines its own models,
containers, and device requirements. Read the upstream entry for the device you
actually own.

## Setup

Follow the upstream repository. Localfirst installs nothing, downloads no
models, and changes no device configuration.

## Execution

Execution happens entirely on your own Jetson device by following the upstream
tutorial you selected.

## Test and evaluation

No supported harness exists for these tutorials, so \`test_support\` is
\`none\`. Any claim about a specific tutorial working on a specific device
remains the reader's own observation.

## Limitations

- A curated listing is not an endorsement, and it is not a test result.
- JetPack version, device variant, and model licensing are unresolved here.
- The upstream content can change at any time; this entry pins no revision.

## Sources and attribution

Curated from <https://github.com/NVIDIA-AI-IOT/jetson-ai-lab> by the Localfirst
curation account. Original authors are the NVIDIA AI IOT contributors; they did
not submit this listing.
`,
};

/** 2 — jetson-inference / Hello AI World. */
const jetsonInference: SeedProject = {
  submitter: 'curator',
  frontmatter: {
    schema: SPEC_SCHEMA_ID,
    project: {
      key: 'jetson-inference-hello-ai-world',
      name: 'jetson-inference (Hello AI World)',
      summary:
        'Curated reference to the jetson-inference examples for vision inference and deployment on Jetson devices.',
      type: 'application',
      categories: ['object-detection', 'vision-language'],
      version: '0.1.0',
      license: { state: 'known', id: 'MIT', reference: 'https://github.com/dusty-nv/jetson-inference/blob/master/LICENSE.md' },
    },
    sources: [
      {
        key: 'upstream-repository',
        kind: 'repository',
        url: 'https://github.com/dusty-nv/jetson-inference',
        revision: null,
        content_digest: null,
        path: null,
        license: { state: 'known', id: 'MIT', reference: 'https://github.com/dusty-nv/jetson-inference/blob/master/LICENSE.md' },
        note: 'Upstream repository; the applicable model licenses are separate from the repository license.',
      },
    ],
    attribution: curatedAttribution([
      { name: 'Dustin Franklin and jetson-inference contributors', url: 'https://github.com/dusty-nv' },
    ]),
    models: UNKNOWN_MODELS,
    runtimes: { state: 'unknown', supported: [] },
    hardware: {
      state: 'declared',
      architectures: ['arm64'],
      minimum_memory_bytes: null,
      minimum_vram_bytes: null,
      accelerator: 'required',
      devices: ['NVIDIA Jetson developer kits'],
    },
    operating_systems: { state: 'declared', supported: ['linux'] },
    dependencies: NO_DEPENDENCIES_DECLARED,
    configurations: [
      {
        key: 'documented-vision-examples',
        model_roles: [],
        setup_kind: 'script_documented',
        workload: { context_tokens: null, concurrency: null },
        note: 'Upstream documents build and container paths; Localfirst runs neither.',
      },
    ],
    data_boundary: {
      inference: 'local_required',
      storage: 'local',
      runtime_network: 'unknown',
      external_services: [],
    },
    test_support: 'manual',
    tests: [],
    limitations: [
      'Vision workloads are outside the planned declarative text harness, so testing stays manual.',
      'Device variant, JetPack version, and model licenses are unresolved in this listing.',
      'Model downloads are the reader’s decision; this listing triggers none.',
      'The repository license does not cover the weights these examples use.',
    ],
    evidence: [
      {
        kind: 'documented',
        summary: 'Upstream documents Jetson deployment paths and example inference pipelines.',
        reference: 'https://github.com/dusty-nv/jetson-inference',
      },
    ],
    media: [],
    derivative_of: null,
  },
  markdown: `## Purpose

Make the well-known jetson-inference examples discoverable with explicit
metadata about device requirements, licensing boundaries, and the absence of
any Localfirst test evidence.

## Architecture and workflow

Upstream provides vision inference examples (classification, detection,
segmentation) with documented build and container paths for Jetson devices.
Model weights are fetched by the reader, under their own licenses.

## Setup

Follow the upstream repository for your device and JetPack version. Localfirst
performs no build, no container pull, and no model download.

## Execution

Run the upstream examples on your own device. Camera and display access are
local concerns that this registry never touches.

## Test and evaluation

\`test_support\` is \`manual\`: a vision pipeline is outside the planned
single-model text harness. A manual build report is the appropriate way to share
an observation once that contribution path ships.

## Limitations

- No measurement, frame rate, or accuracy figure is claimed here.
- Repository licensing is distinct from the licensing of any model used.
- Compatibility with a specific Jetson variant is documented upstream, not verified here.

## Sources and attribution

Curated from <https://github.com/dusty-nv/jetson-inference>. Original authors
are the upstream maintainers and contributors; they did not submit this listing.
`,
};

/** 3 — JetBot robotics kit. */
const jetbot: SeedProject = {
  submitter: 'curator',
  frontmatter: {
    schema: SPEC_SCHEMA_ID,
    project: {
      key: 'jetbot-robotics-kit',
      name: 'JetBot',
      summary:
        'Curated reference to the JetBot open-source robotics kit built around NVIDIA Jetson devices.',
      type: 'robotics',
      categories: ['robotics-control', 'hardware-setup'],
      version: '0.1.0',
      license: { state: 'known', id: 'MIT', reference: 'https://github.com/NVIDIA-AI-IOT/jetbot/blob/master/LICENSE.md' },
    },
    sources: [
      {
        key: 'upstream-repository',
        kind: 'repository',
        url: 'https://github.com/NVIDIA-AI-IOT/jetbot',
        revision: null,
        content_digest: null,
        path: null,
        license: { state: 'known', id: 'MIT', reference: 'https://github.com/NVIDIA-AI-IOT/jetbot/blob/master/LICENSE.md' },
        note: 'Upstream repository including hardware assembly documentation.',
      },
    ],
    attribution: curatedAttribution([
      { name: 'NVIDIA AI IOT contributors', url: 'https://github.com/NVIDIA-AI-IOT' },
    ]),
    models: UNKNOWN_MODELS,
    runtimes: { state: 'unknown', supported: [] },
    hardware: {
      state: 'declared',
      architectures: ['arm64'],
      minimum_memory_bytes: null,
      minimum_vram_bytes: null,
      accelerator: 'required',
      devices: ['NVIDIA Jetson developer kits', 'JetBot chassis and motor hardware'],
    },
    operating_systems: { state: 'declared', supported: ['linux'] },
    dependencies: NO_DEPENDENCIES_DECLARED,
    configurations: [
      {
        key: 'documented-assembly-and-notebooks',
        model_roles: [],
        setup_kind: 'manual',
        workload: { context_tokens: null, concurrency: null },
        note: 'Physical assembly plus upstream notebooks; no automated path exists.',
      },
    ],
    data_boundary: {
      inference: 'local_required',
      storage: 'local',
      runtime_network: 'unknown',
      external_services: [],
    },
    test_support: 'manual',
    tests: [],
    limitations: [
      'Actuation and physical robots are outside any supported Localfirst harness.',
      'Assembly requires parts and tools this listing does not verify you have.',
      'Safety when moving a physical robot is entirely the builder’s responsibility.',
      'No Localfirst test has been run, and no behaviour is guaranteed.',
    ],
    evidence: [
      {
        kind: 'documented',
        summary: 'Upstream documents the hardware build and the notebooks that drive it.',
        reference: 'https://github.com/NVIDIA-AI-IOT/jetbot',
      },
    ],
    media: [],
    derivative_of: null,
  },
  markdown: `## Purpose

Record the JetBot kit as a hardware-plus-software entry so robotics builders can
find it with accurate expectations: it is a physical build with documented
software, and nothing here is automatically testable.

## Architecture and workflow

A Jetson device drives a small wheeled chassis. Upstream notebooks cover
teleoperation, collision avoidance, and road following. Each requires a built
robot and a reader who can run it safely.

## Setup

Assemble the hardware and follow the upstream software setup. Localfirst does
not order parts, flash images, or configure devices.

## Execution

Execution means moving a physical robot. Clear the area, keep the robot
supervised, and expect to iterate.

## Test and evaluation

\`test_support\` is \`manual\`. Actuation tests are explicitly out of scope for
the planned harness, and a formatted report would not change that.

## Limitations

- A physical robot can cause damage or injury; no automated gate protects you here.
- Part availability, device variant, and software versions are unresolved.
- No performance or reliability claim is made.

## Sources and attribution

Curated from <https://github.com/NVIDIA-AI-IOT/jetbot>. Original authors are the
NVIDIA AI IOT contributors; they did not submit this listing.
`,
};

/** 4 — Jetson Device Skills (agent-readable device workflows). */
const deviceSkills: SeedProject = {
  submitter: 'curator',
  frontmatter: {
    schema: SPEC_SCHEMA_ID,
    project: {
      key: 'jetson-device-skills',
      name: 'Jetson Device Skills',
      summary:
        'Curated reference to agent-readable device workflow skills for NVIDIA Jetson hardware.',
      type: 'workflow',
      categories: ['agent-workflow', 'hardware-setup'],
      version: '0.1.0',
      license: { state: 'unknown', id: null, reference: null },
    },
    sources: [
      {
        key: 'upstream-repository',
        kind: 'repository',
        url: 'https://github.com/NVIDIA-AI-IOT/jetson-device-skills',
        revision: null,
        content_digest: null,
        path: null,
        license: { state: 'unknown', id: null, reference: null },
        note: 'Upstream repository of device workflow skills; check its license before reuse.',
      },
    ],
    attribution: curatedAttribution([
      { name: 'NVIDIA AI IOT contributors', url: 'https://github.com/NVIDIA-AI-IOT' },
    ]),
    models: UNKNOWN_MODELS,
    runtimes: { state: 'unknown', supported: [] },
    hardware: {
      state: 'declared',
      architectures: ['arm64'],
      minimum_memory_bytes: null,
      minimum_vram_bytes: null,
      accelerator: 'optional',
      devices: ['NVIDIA Jetson developer kits'],
    },
    operating_systems: { state: 'declared', supported: ['linux'] },
    dependencies: NO_DEPENDENCIES_DECLARED,
    configurations: [
      {
        key: 'agent-readable-workflows',
        model_roles: [],
        setup_kind: 'manual',
        workload: { context_tokens: null, concurrency: null },
        note: 'Workflow descriptions an agent can read; Localfirst executes none of them.',
      },
    ],
    data_boundary: {
      inference: 'unknown',
      storage: 'local',
      runtime_network: 'unknown',
      external_services: [],
    },
    test_support: 'manual',
    tests: [],
    limitations: [
      'Agent-readable workflows are an integration precedent, not proof of compatibility.',
      'Any workflow that changes a device requires the owner’s separate, explicit approval locally.',
      'Licensing is unresolved and recorded as unknown.',
      'No Localfirst harness executes these workflows.',
    ],
    evidence: [
      {
        kind: 'documented',
        summary: 'Upstream publishes device workflow skills intended for agent consumption.',
        reference: 'https://github.com/NVIDIA-AI-IOT/jetson-device-skills',
      },
    ],
    media: [],
    derivative_of: null,
  },
  markdown: `## Purpose

Track an existing precedent for agent-readable device workflows, so Localfirst's
own contracts can be compared against it instead of inventing a format in
isolation.

## Architecture and workflow

Upstream describes device-level tasks in a form an agent can read. Executing any
of them touches real hardware and belongs to the device owner's machine.

## Setup

Read the upstream repository. Localfirst changes no device state and runs no
workflow.

## Execution

Any execution happens locally, under the device owner's own permissions and
with their explicit approval for the specific effect.

## Test and evaluation

\`test_support\` is \`manual\`. A workflow that reconfigures a device is not a
bounded text task and is not covered by the planned harness.

## Limitations

- Reading a workflow description establishes nothing about your device.
- Device-changing steps need separate local authorization for each effect.
- Licensing and supported device variants are unknown here.

## Sources and attribution

Curated from <https://github.com/NVIDIA-AI-IOT/jetson-device-skills>. Original
authors are the NVIDIA AI IOT contributors; they did not submit this listing.
`,
};

/** 5 — Jetson community projects directory (documentation source, no repository). */
const communityDirectory: SeedProject = {
  submitter: 'curator',
  frontmatter: {
    schema: SPEC_SCHEMA_ID,
    project: {
      key: 'jetson-community-projects-directory',
      name: 'Jetson community projects directory',
      summary:
        'Curated reference to NVIDIA’s directory of community-built Jetson projects, used as a discovery starting point.',
      type: 'documentation',
      categories: ['documentation'],
      version: '0.1.0',
      license: { state: 'unknown', id: null, reference: null },
    },
    sources: [
      {
        key: 'upstream-directory',
        kind: 'documentation',
        url: 'https://developer.nvidia.com/embedded/community/jetson-projects',
        revision: null,
        content_digest: null,
        path: null,
        license: { state: 'unknown', id: null, reference: null },
        note: 'A mutable web page. The registry has not fetched it, so its state is declared, not verified.',
      },
    ],
    attribution: curatedAttribution([{ name: 'NVIDIA and listed project authors', url: 'https://developer.nvidia.com' }]),
    models: UNKNOWN_MODELS,
    runtimes: { state: 'unknown', supported: [] },
    hardware: {
      state: 'declared',
      architectures: ['arm64'],
      minimum_memory_bytes: null,
      minimum_vram_bytes: null,
      accelerator: 'unknown',
      devices: ['NVIDIA Jetson developer kits'],
    },
    operating_systems: { state: 'declared', supported: ['linux'] },
    dependencies: { state: 'not_applicable', items: [] },
    configurations: [
      {
        key: 'directory-browsing',
        model_roles: [],
        setup_kind: 'unsupported',
        workload: { context_tokens: null, concurrency: null },
        note: 'A directory of other people’s projects; there is nothing to set up.',
      },
    ],
    data_boundary: {
      inference: 'unknown',
      storage: 'unknown',
      runtime_network: 'required',
      external_services: ['developer.nvidia.com'],
    },
    test_support: 'none',
    tests: [],
    limitations: [
      'This entry is a pointer to a mutable web page with no pinned revision.',
      'Each listed project has its own authors, license, device requirements, and quality.',
      'Inclusion in a directory is not evidence that any listed project works.',
      'Reading the directory requires network access, so it is not an offline resource.',
    ],
    evidence: [
      {
        kind: 'claimed',
        summary: 'The directory is a commonly used discovery surface for Jetson builder projects.',
        reference: 'https://developer.nvidia.com/embedded/community/jetson-projects',
      },
    ],
    media: [],
    derivative_of: null,
  },
  markdown: `## Purpose

Record where Jetson builders already look for projects, so Localfirst curation
can start from existing community work with attribution instead of pretending to
be the first index.

## Architecture and workflow

None of its own. The upstream page links to projects authored and maintained by
other people.

## Setup

Open the directory in a browser. Localfirst does not fetch, mirror, or cache its
contents.

## Execution

Nothing executes. Each linked project has its own instructions, hardware needs,
and licensing.

## Test and evaluation

\`test_support\` is \`none\`. A directory cannot be tested, and the projects it
lists are not covered by this entry.

## Limitations

- The page is mutable and unpinned; its content may already differ from this record.
- No listed project inherits any evidence from this listing.
- Network access is required, so this is explicitly not an offline resource.

## Sources and attribution

Curated from <https://developer.nvidia.com/embedded/community/jetson-projects>.
Original authors are NVIDIA and the individual project authors; they did not
submit this listing.
`,
};

/** 6 — Documentation-only hardware entry with no upstream host (section 4.3). */
const authoredHardwareNotes: SeedProject = {
  submitter: 'builder',
  frontmatter: {
    schema: SPEC_SCHEMA_ID,
    project: {
      key: 'edge-llm-workstation-notes',
      name: 'Edge LLM workstation notes',
      summary:
        'An original hardware build note for a small always-on local LLM workstation, published as documentation with no upstream host.',
      type: 'hardware_build',
      categories: ['hardware-setup', 'documentation'],
      version: '0.1.0',
      license: { state: 'known', id: 'CC-BY-4.0', reference: 'https://creativecommons.org/licenses/by/4.0/' },
    },
    sources: [
      {
        key: 'authored-notes',
        kind: 'authored_specification',
        url: null,
        revision: null,
        content_digest: null,
        path: null,
        license: { state: 'known', id: 'CC-BY-4.0', reference: 'https://creativecommons.org/licenses/by/4.0/' },
        note: 'Written for Localfirst; the canonical copy is this immutable specification.',
      },
    ],
    attribution: {
      authors: [{ name: 'Localfirst example builder', url: null }],
      relationship: 'original_author_claimed',
    },
    models: {
      state: 'declared',
      roles: [
        {
          key: 'assistant',
          required_capabilities: ['chat'],
          minimum_context_tokens: 8192,
          substitution: 'allowed_for_task_test',
          preferred: null,
        },
      ],
    },
    runtimes: {
      state: 'declared',
      supported: [
        { family: 'ollama', version_constraint: null },
        { family: 'lmstudio', version_constraint: null },
      ],
    },
    hardware: {
      state: 'declared',
      architectures: ['arm64', 'x86_64'],
      minimum_memory_bytes: 17179869184,
      minimum_vram_bytes: null,
      accelerator: 'optional',
      devices: ['Small-form-factor desktop or mini PC'],
    },
    operating_systems: { state: 'declared', supported: ['linux', 'macos'] },
    dependencies: { state: 'declared', items: [] },
    configurations: [
      {
        key: 'always-on-assistant',
        model_roles: ['assistant'],
        setup_kind: 'manual',
        workload: { context_tokens: 8192, concurrency: 1 },
        note: 'One chat model loaded on demand for a single user.',
      },
    ],
    data_boundary: {
      inference: 'local_required',
      storage: 'local',
      runtime_network: 'optional',
      external_services: [],
    },
    test_support: 'none',
    tests: [],
    limitations: [
      'This is a declared build plan with no measurements: no latency, token rate, or memory figure was observed.',
      'The 16 GiB minimum is an author estimate, not a measured fit for any specific model.',
      'Hardware prices, availability, and thermal behaviour are outside this note.',
      'Because runtime network use is optional rather than none, offline operation is not claimed.',
    ],
    evidence: [],
    media: [],
    derivative_of: null,
  },
  markdown: `## Purpose

Describe a small, quiet, always-on machine for running one local chat model, so
that someone planning a similar build has a starting checklist rather than a
benchmark table.

## Architecture and workflow

A single-user setup: one local runtime (Ollama or LM Studio) holds one chat model
loaded on demand. There is no cluster, queue, reverse proxy, or remote endpoint.

## Setup

1. Choose a small-form-factor machine with at least 16 GiB of system memory.
2. Install one supported local runtime yourself.
3. Pull a chat model that fits comfortably in the memory you actually have.
4. Keep the runtime bound to loopback. Do not expose it to a LAN or the internet.

## Execution

Open your own client against the local runtime. Nothing in this note sends data
to a service, and no step here requires an account.

## Test and evaluation

\`test_support\` is \`none\`: this is a documentation entry. When a supported
runner ships, a bounded text task could be declared separately; until then there
is nothing to run and nothing has been run.

## Limitations

- Every number in this note is a declared requirement or an estimate.
- Model fit depends on quantization, context length, and concurrent use, none of which are measured here.
- A local HTTP endpoint is not by itself proof of local execution; check your runtime's own configuration.

## Sources and attribution

Original note authored for Localfirst by the example builder account and
published under CC-BY-4.0. There is no upstream repository or external document
backing it: the immutable specification above is the canonical copy.
`,
};

/** 7 — The PRD reference example, with its declared (never executed) test. */
const referenceFixture: SeedProject = {
  submitter: 'builder',
  frontmatter: {},
  markdown: '',
  files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }],
};

export function seedDocuments(): Array<{
  submitter: SeedProject['submitter'];
  project_md: string;
  files: Array<{ path: string; content: string }>;
}> {
  const curated = [jetsonAiLab, jetsonInference, jetbot, deviceSkills, communityDirectory, authoredHardwareNotes];
  const documents = curated.map((entry) => ({
    submitter: entry.submitter,
    project_md: serializeProjectDocument(entry.frontmatter, entry.markdown),
    files: entry.files ?? [],
  }));
  // The reference example ships verbatim from the shared contracts package so
  // the catalog always contains one declared-but-unrun task fixture.
  documents.push({
    submitter: referenceFixture.submitter,
    project_md: EXAMPLE_PROJECT_MD,
    files: referenceFixture.files ?? [],
  });
  return documents;
}

/** Coarse public hardware descriptors seeded for filtering (section 12.1). */
export const SEED_HARDWARE_DESCRIPTORS = [
  {
    key: 'nvidia-jetson-developer-kits',
    displayName: 'NVIDIA Jetson developer kits',
    platform: 'nvidia-jetson',
    cpuArchitecture: 'arm64',
    accelerator: 'cuda',
    // Variant-dependent: a single figure would misrepresent the family.
    memoryBytes: null,
    vramBytes: null,
    unifiedMemory: true,
    docsUrl: 'https://developer.nvidia.com/embedded/jetson-modules',
    details: {
      origin: 'vendor_documentation',
      note: 'Memory, accelerator capability, and JetPack support differ per module and carrier board.',
    },
  },
  {
    key: 'apple-silicon-mac',
    displayName: 'Apple silicon Mac',
    platform: 'apple-silicon',
    cpuArchitecture: 'arm64',
    accelerator: 'metal',
    memoryBytes: null,
    vramBytes: null,
    unifiedMemory: true,
    docsUrl: 'https://support.apple.com/en-us/116943',
    details: {
      origin: 'vendor_documentation',
      note: 'Unified memory is shared with the GPU and must never be counted twice.',
    },
  },
  {
    key: 'small-form-factor-desktop-or-mini-pc',
    displayName: 'Small-form-factor desktop or mini PC',
    platform: 'generic-desktop',
    cpuArchitecture: null,
    accelerator: null,
    memoryBytes: null,
    vramBytes: null,
    unifiedMemory: null,
    docsUrl: null,
    details: { origin: 'author_declaration', note: 'A broad descriptor, not a specific product.' },
  },
];

/** Runtime references with honest support status (no adapter has shipped). */
export const SEED_RUNTIME_REFERENCES = [
  {
    family: 'ollama',
    displayName: 'Ollama',
    apiProfile: 'ollama-native/v0.1',
    supportStatus: 'declared_only' as const,
    docsUrl: 'https://docs.ollama.com/api/introduction',
    details: {
      note: 'A Phase 2 adapter is designed but not shipped. Local and cloud models can both appear behind one local server, so locality must be checked locally.',
    },
  },
  {
    family: 'lmstudio',
    displayName: 'LM Studio',
    apiProfile: 'lmstudio-openai-compat/v1',
    supportStatus: 'declared_only' as const,
    docsUrl: 'https://lmstudio.ai/docs/developer/rest/list',
    details: {
      note: 'A Phase 2 adapter is designed but not shipped. Native and OpenAI-compatible endpoints expose different metadata and timings.',
    },
  },
];
