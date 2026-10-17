import { it, expect, describe } from 'vitest';
import { digestOf, digestOfBytes, LANGGRAPH_LOCK_DIGEST } from '@localfirst/contracts';
import { containerRunArgs, preparedFrameworkSchema, lockedArtifacts, frameworkRecipe } from '../src/frameworks/docker.js';

const digest = 'sha256:' + '1'.repeat(64);
const body = { schema: 'localfirst/prepared-framework/v0.1' as const, profile: 'langgraph-docker/v0.1' as const, sdk_version: '1.5.0' as const, image_id: digest, entry_digest: digest, lock_digest: LANGGRAPH_LOCK_DIGEST, worker_digest: digest, base_image: 'node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20' as const, docker_endpoint: 'unix:///var/run/docker.sock' };
describe('isolated framework contract', () => {
  it('ships an exact framework lock containing only integrity-verified registry artifacts', async () => {
    const recipe = await frameworkRecipe();
    expect(digestOfBytes(recipe.lockText)).toBe(LANGGRAPH_LOCK_DIGEST);
    expect(recipe.artifacts.length).toBeGreaterThan(1);
    expect(recipe.artifacts.every(a => a.url.startsWith('https://registry.npmjs.org/') && a.integrity.startsWith('sha512-'))).toBe(true);
    expect(() => lockedArtifacts('{"dependencies":{"@langchain/langgraph":"latest"}}', recipe.lockText)).toThrow('invalid_framework_lock');
    const modified = JSON.parse(recipe.lockText);
    Object.values(modified.packages).find((p: any) => p.resolved)!.resolved = 'https://example.com/payload.tgz';
    expect(() => lockedArtifacts(recipe.packageText, JSON.stringify(modified))).toThrow('framework_source_not_allowed');
  });
  it('refuses modified artifacts and remote Docker endpoints', () => {
    const artifact = { ...body, artifact_digest: digestOf(body) };
    expect(preparedFrameworkSchema.safeParse(artifact).success).toBe(true);
    expect(preparedFrameworkSchema.safeParse({ ...artifact, image_id: 'sha256:' + '2'.repeat(64) }).success).toBe(false);
    expect(preparedFrameworkSchema.safeParse({ ...artifact, docker_endpoint: 'tcp://remote:2375' }).success).toBe(false);
  });
  it('runs with no mounts/network/capabilities and bounded resources', () => {
    const artifact = preparedFrameworkSchema.parse({ ...body, artifact_digest: digestOf(body) });
    const args = containerRunArgs(artifact, 'localfirst-test');
    for (const constraint of ['--pull=never', '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=512m', '--cpus=1']) expect(args).toContain(constraint);
    expect(args.some(a => /mount|volume|privileged|publish/.test(a))).toBe(false);
    expect(args).toContain(artifact.image_id);
  });
});
