import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { digestOf, digestOfBytes, boundedJson, scanSecrets, scanContentShape, LANGGRAPH_LOCK_DIGEST, type AgentEnvironment } from '@localfirst/contracts';
import { WorkflowError } from '../workflows/state.js';

export const FRAMEWORK_PROFILE = 'langgraph-docker/v0.1';
export const FRAMEWORK_VERSION = '1.5.0';
export const BASE_IMAGE = 'node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const preparedFrameworkSchema = z.object({
  schema: z.literal('localfirst/prepared-framework/v0.1'), profile: z.literal(FRAMEWORK_PROFILE),
  sdk_version: z.literal(FRAMEWORK_VERSION), image_id: imageId, entry_digest: imageId,
  lock_digest: z.literal(LANGGRAPH_LOCK_DIGEST), worker_digest: imageId, base_image: z.literal(BASE_IMAGE),
  docker_endpoint: z.string().regex(/^unix:\/\/\/[^\n\r\0]+$/),
  artifact_digest: imageId,
}).strict().superRefine((value, ctx) => {
  const { artifact_digest, ...body } = value;
  if (digestOf(body) !== artifact_digest) ctx.addIssue({ code: 'custom', message: 'framework artifact digest mismatch' });
});
export type PreparedFramework = z.infer<typeof preparedFrameworkSchema>;
const cleanEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' });

async function docker(args: string[], signal?: AbortSignal, localBuild = false): Promise<string> {
  const configDir = localBuild ? await mkdtemp(join(tmpdir(), 'localfirst-docker-config-')) : null;
  if (configDir) await writeFile(join(configDir, 'config.json'), '{"auths":{}}', { mode: 0o600 });
  try { return await new Promise<string>((resolve, reject) => {
    const child = spawn('docker', configDir ? ['--config', configDir, ...args] : args, { env: { ...cleanEnv(), ...(localBuild ? { DOCKER_BUILDKIT: '0' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let output = '', size = 0, failed = false;
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { failed = true; child.kill(); return; }
      output += chunk.toString();
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', code => code === 0 && !failed ? resolve(output.trim()) : reject(new WorkflowError('docker_command_failed')));
  }); } finally { if (configDir) await rm(configDir, { recursive: true, force: true }); }
}
export async function localDockerEndpoint(): Promise<string> {
  const host = JSON.parse(await docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], AbortSignal.timeout(10000))) as string;
  if (!/^unix:\/\/\/[^\n\r\0]+$/.test(host)) throw new WorkflowError('remote_docker_not_allowed');
  const os = await docker(['--host', host, 'info', '--format', '{{.OSType}}'], AbortSignal.timeout(10000));
  if (os !== 'linux') throw new WorkflowError('unsupported_container_platform');
  return host;
}

/** Lockfile installs only exact, integrity-bound registry artifacts; no lifecycle hooks. */
export function lockedArtifacts(packageText: string, lockText: string) {
  const pkg = JSON.parse(packageText) as { dependencies?: Record<string, string>; scripts?: unknown };
  const lock = JSON.parse(lockText) as { lockfileVersion?: number; packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean; version?: string }> };
  if (pkg.scripts || digestOf(pkg.dependencies) !== digestOf({ '@langchain/langgraph': FRAMEWORK_VERSION }) || lock.lockfileVersion !== 3 || !lock.packages) throw new WorkflowError('invalid_framework_lock');
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
  if (!entries.length || entries.length > 128) throw new WorkflowError('framework_dependency_limit');
  return entries.map(([path, entry]) => {
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path) || entry.link || !entry.resolved || !entry.integrity ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) throw new WorkflowError('invalid_framework_dependency');
    const url = new URL(entry.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) throw new WorkflowError('framework_source_not_allowed');
    return { url: url.href, integrity: entry.integrity };
  });
}
async function downloadArtifact(url: string, expected: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 16 * 1024 * 1024 || !response.body) throw new WorkflowError('framework_download_failed');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw new WorkflowError('framework_download_limit');
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  if ('sha512-' + createHash('sha512').update(data).digest('base64') !== expected) throw new WorkflowError('framework_integrity_mismatch');
  return data;
}
const runtimeDir = new URL('../../frameworks/langgraph/', import.meta.url);
export async function frameworkRecipe() {
  const [packageText, lockText, worker] = await Promise.all(['package.json', 'npm-shrinkwrap.json', 'worker.mjs'].map(f => readFile(new URL(f, runtimeDir), 'utf8')));
  if (digestOfBytes(lockText!) !== LANGGRAPH_LOCK_DIGEST) throw new WorkflowError('framework_lock_changed');
  return { packageText: packageText!, lockText: lockText!, worker: worker!, artifacts: lockedArtifacts(packageText!, lockText!) };
}
/** Called only after the caller has shown and received separate setup approval. */
export async function prepareFramework(source: string, endpoint: string, signal?: AbortSignal): Promise<PreparedFramework> {
  if (!/^unix:\/\/\//.test(endpoint) || Buffer.byteLength(source) > 65536) throw new WorkflowError('invalid_framework_setup');
  if (scanSecrets(source, 'creator_module').length || scanContentShape(source, 'creator_module').length) throw new WorkflowError('framework_source_rejected');
  const recipe = await frameworkRecipe();
  await docker(['--host', endpoint, 'image', 'inspect', BASE_IMAGE], AbortSignal.timeout(10000));
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
  const directory = await mkdtemp(join(tmpdir(), 'localfirst-framework-'));
  try {
    await writeFile(join(directory, 'package.json'), recipe.packageText, { mode: 0o600 });
    await writeFile(join(directory, 'package-lock.json'), recipe.lockText, { mode: 0o600 });
    await writeFile(join(directory, 'worker.mjs'), recipe.worker, { mode: 0o600 });
    await writeFile(join(directory, 'project.mjs'), source, { mode: 0o600 });
    let total = 0;
    for (let i = 0; i < recipe.artifacts.length; i++) {
      const artifact = recipe.artifacts[i]!, data = await downloadArtifact(artifact.url, artifact.integrity, deadline);
      total += data.length;
      if (total > 128 * 1024 * 1024) throw new WorkflowError('framework_download_limit');
      await writeFile(join(directory, 'artifact-' + i + '.tgz'), data, { mode: 0o600 });
    }
    const dockerfile = [
      'FROM ' + BASE_IMAGE, 'WORKDIR /app', 'COPY package.json package-lock.json artifact-*.tgz ./',
      'RUN for f in artifact-*.tgz; do npm cache add "$f" --ignore-scripts; done && npm ci --offline --ignore-scripts --no-audit --no-fund && rm artifact-*.tgz && npm cache clean --force',
      'COPY worker.mjs project.mjs ./', 'RUN chmod -R a+rX /app', 'USER 10001:10001', 'ENV LANGSMITH_TRACING=false',
    ].join('\n') + '\n';
    await writeFile(join(directory, 'Dockerfile'), dockerfile, { mode: 0o600 });
    await docker(['--host', endpoint, 'build', '--network=none', '--pull=false', '--iidfile', join(directory, 'image-id'), directory], deadline, true);
    const id = imageId.parse((await readFile(join(directory, 'image-id'), 'utf8')).trim());
    const body = { schema: 'localfirst/prepared-framework/v0.1' as const, profile: FRAMEWORK_PROFILE as typeof FRAMEWORK_PROFILE,
      sdk_version: FRAMEWORK_VERSION as typeof FRAMEWORK_VERSION, image_id: id, entry_digest: digestOfBytes(source), lock_digest: digestOfBytes(recipe.lockText),
      worker_digest: digestOfBytes(recipe.worker), base_image: BASE_IMAGE as typeof BASE_IMAGE, docker_endpoint: endpoint };
    return preparedFrameworkSchema.parse({ ...body, artifact_digest: digestOf(body) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export interface WorkflowScheduler {
  startCase(environment: AgentEnvironment): Promise<void>;
  beforeStep(id: string): Promise<void>;
  afterStep(id: string, output: unknown): Promise<void>;
  finishCase(): Promise<void>;
  closeCase(): Promise<void>;
}
export function containerRunArgs(artifact: PreparedFramework, name: string): string[] {
  return ['--host', artifact.docker_endpoint, 'run', '--pull=never', '--rm', '--init', '--name', name, '--network=none', '--read-only',
    '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=512m', '--cpus=1',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '--entrypoint=node', '-i', artifact.image_id, '--disable-proto=throw', '/app/worker.mjs'];
}
/** Only expected graph step IDs cross the broker. No URLs, tools, credentials or shell requests are accepted. */
export class DockerWorkflowScheduler implements WorkflowScheduler {
  private child: ReturnType<typeof spawn> | null = null;
  private name = '';
  private messages: unknown[] = [];
  private pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  constructor(readonly artifact: PreparedFramework) { preparedFrameworkSchema.parse(artifact); }
  private receive(): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  private reject(error: Error) { this.failure = error; this.pending?.reject(error); this.pending = null; }
  private async expect(type: string, id?: string) {
    const raw = await this.receive();
    const message = z.object({ type: z.enum(['ready', 'step', 'done']), id: z.string().max(64).optional() }).strict().safeParse(raw);
    if (!message.success || message.data.type !== type || message.data.id !== id) throw new WorkflowError('framework_protocol_violation');
  }
  async startCase(environment: AgentEnvironment) {
    this.messages = []; this.pending = null; this.failure = null;
    this.name = 'localfirst-fw-' + randomBytes(8).toString('hex');
    this.child = spawn('docker', containerRunArgs(this.artifact, this.name), { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, stderrBytes = 0;
    this.child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length; buffer += chunk.toString();
      if (bytes > 1024 * 1024 || Buffer.byteLength(buffer) > 65536) { this.reject(new WorkflowError('framework_output_limit')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!boundedJson(message)) throw new Error();
          if (this.pending) { this.pending.resolve(message); this.pending = null; } else {
            this.messages.push(message);
            if (this.messages.length > 16) this.reject(new WorkflowError('framework_output_limit'));
          }
        } catch { this.reject(new WorkflowError('framework_protocol_violation')); }
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) this.reject(new WorkflowError('framework_output_limit')); });
    this.child.on('error', () => this.reject(new WorkflowError('framework_start_failed')));
    this.child.on('close', () => { if (this.pending) this.reject(new WorkflowError('framework_terminated')); });
    this.child.stdin?.on('error', () => this.reject(new WorkflowError('framework_terminated')));
    this.child.stdin?.write(JSON.stringify({ type: 'start', node_ids: environment.nodes.map(n => n.id) }) + '\n');
    await this.expect('ready');
  }
  async beforeStep(id: string) { await this.expect('step', id); }
  async afterStep(id: string, output: unknown) {
    if (!boundedJson(output) || !this.child?.stdin?.writable) throw new WorkflowError('framework_protocol_violation');
    await new Promise<void>((resolve, reject) => this.child!.stdin!.write(JSON.stringify({ type: 'result', id, output }) + '\n', error => error ? reject(new WorkflowError('framework_terminated')) : resolve()));
  }
  async finishCase() { await this.expect('done'); }
  async closeCase() {
    if (!this.name) return;
    try {
      await docker(['--host', this.artifact.docker_endpoint, 'rm', '-f', this.name], AbortSignal.timeout(10000));
    } catch {
      // --rm may already have removed a normally completed container; prove absence.
      const list = await docker(['--host', this.artifact.docker_endpoint, 'ps', '-aq', '--filter', 'name=^/' + this.name + '$'], AbortSignal.timeout(10000));
      if (list !== '') throw new WorkflowError('framework_cleanup_failed');
    } finally { this.child?.kill(); this.child = null; this.pending?.reject(new WorkflowError('framework_terminated')); this.pending = null; this.name = ''; }
  }
}
