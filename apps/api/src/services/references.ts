/**
 * Normalized model, runtime, and hardware reference rows (BACKEND_PRD sections
 * 16.1, 12.1).
 *
 * These are deduplication and filter keys that connect project records. They
 * are not four fully featured catalogs, they host no weights, and they never
 * hold a private machine inventory.
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { ProjectSpec } from '@localfirst/contracts';
import {
  hardwareDescriptors,
  modelReferences,
  projects,
  projectVersionHardware,
  projectVersionModelRoles,
  projectVersionRuntimes,
  projectVersions,
  runtimeReferences,
} from '../db/schema/registry.js';
import { db, type DbOrTx } from '../db/client.js';
import { slugify } from '../domain/slug.js';

/** A creator's model hint, normalized into a dedupe key. */
export function modelKeyFromHint(hint: string): string {
  return slugify(hint.replace(/[:/]/g, '-')).slice(0, 64);
}

export function hardwareKeyFromDevice(device: string): string {
  return slugify(device).slice(0, 64);
}

async function upsertModelReference(tx: DbOrTx, hint: string): Promise<string> {
  const key = modelKeyFromHint(hint);
  const [existing] = await tx
    .select({ id: modelReferences.id })
    .from(modelReferences)
    .where(eq(modelReferences.key, key))
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await tx
    .insert(modelReferences)
    .values({
      key,
      displayName: hint.slice(0, 200),
      family: hint.includes(':') ? (hint.split(':')[0] ?? null) : null,
      // A creator hint establishes no license, identity scheme, or source.
      licenseState: 'unknown',
      details: { origin: 'project_declaration', declared_identifier: hint },
    })
    .onConflictDoUpdate({
      target: modelReferences.key,
      set: { displayName: sql`${modelReferences.displayName}` },
    })
    .returning({ id: modelReferences.id });
  if (inserted) return inserted.id;
  const [row] = await tx
    .select({ id: modelReferences.id })
    .from(modelReferences)
    .where(eq(modelReferences.key, key))
    .limit(1);
  return row?.id ?? '';
}

async function upsertRuntimeReference(tx: DbOrTx, family: string): Promise<string> {
  const [existing] = await tx
    .select({ id: runtimeReferences.id })
    .from(runtimeReferences)
    .where(eq(runtimeReferences.family, family))
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await tx
    .insert(runtimeReferences)
    .values({
      family,
      displayName: family,
      // No adapter has shipped in Phase 1, so support stays `declared_only`.
      supportStatus: 'declared_only',
      details: { origin: 'project_declaration' },
    })
    .onConflictDoUpdate({
      target: runtimeReferences.family,
      set: { displayName: sql`${runtimeReferences.displayName}` },
    })
    .returning({ id: runtimeReferences.id });
  if (inserted) return inserted.id;
  const [row] = await tx
    .select({ id: runtimeReferences.id })
    .from(runtimeReferences)
    .where(eq(runtimeReferences.family, family))
    .limit(1);
  return row?.id ?? '';
}

async function upsertHardwareDescriptor(
  tx: DbOrTx,
  device: string,
  spec: ProjectSpec,
): Promise<string> {
  const key = hardwareKeyFromDevice(device);
  const [existing] = await tx
    .select({ id: hardwareDescriptors.id })
    .from(hardwareDescriptors)
    .where(eq(hardwareDescriptors.key, key))
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await tx
    .insert(hardwareDescriptors)
    .values({
      key,
      displayName: device.slice(0, 200),
      cpuArchitecture: spec.hardware.architectures[0] ?? null,
      accelerator: spec.hardware.accelerator === 'none' ? null : spec.hardware.accelerator,
      details: { origin: 'project_declaration', declared_device: device },
    })
    .onConflictDoUpdate({
      target: hardwareDescriptors.key,
      set: { displayName: sql`${hardwareDescriptors.displayName}` },
    })
    .returning({ id: hardwareDescriptors.id });
  if (inserted) return inserted.id;
  const [row] = await tx
    .select({ id: hardwareDescriptors.id })
    .from(hardwareDescriptors)
    .where(eq(hardwareDescriptors.key, key))
    .limit(1);
  return row?.id ?? '';
}

export interface LinkedReferences {
  modelKeys: string[];
  runtimeFamilies: string[];
  hardwareKeys: string[];
}

/** Link a freshly inserted immutable version to its reference rows. */
export async function linkVersionReferences(
  tx: DbOrTx,
  projectVersionId: string,
  spec: ProjectSpec,
): Promise<LinkedReferences> {
  const modelKeys: string[] = [];
  for (const role of spec.models.roles) {
    const modelReferenceId = role.preferred ? await upsertModelReference(tx, role.preferred) : null;
    if (role.preferred) modelKeys.push(modelKeyFromHint(role.preferred));
    await tx.insert(projectVersionModelRoles).values({
      projectVersionId,
      roleKey: role.key,
      requiredCapabilities: role.required_capabilities,
      minimumContextTokens: role.minimum_context_tokens,
      substitution: role.substitution,
      modelReferenceId: modelReferenceId && modelReferenceId.length > 0 ? modelReferenceId : null,
      preferredHint: role.preferred,
    });
  }

  const runtimeFamilies: string[] = [];
  for (const runtime of spec.runtimes.supported) {
    const runtimeReferenceId = await upsertRuntimeReference(tx, runtime.family);
    runtimeFamilies.push(runtime.family);
    await tx
      .insert(projectVersionRuntimes)
      .values({
        projectVersionId,
        runtimeReferenceId,
        versionConstraint: runtime.version_constraint,
      })
      .onConflictDoNothing();
  }

  const hardwareKeys: string[] = [];
  for (const device of spec.hardware.devices) {
    const hardwareDescriptorId = await upsertHardwareDescriptor(tx, device, spec);
    hardwareKeys.push(hardwareKeyFromDevice(device));
    await tx
      .insert(projectVersionHardware)
      .values({ projectVersionId, hardwareDescriptorId, relation: 'declared_requirement' })
      .onConflictDoNothing();
  }

  return { modelKeys, runtimeFamilies, hardwareKeys };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECLARING_PROJECTS_LIMIT = 50;

/**
 * Joins a version to its project only when that version is the current one of
 * a published project, so hidden, quarantined, and superseded declarations
 * neither list a reference nor count toward it.
 */
export const visibleCurrentProject = and(
  eq(projects.id, projectVersions.projectId),
  eq(projects.currentVersionId, projectVersions.id),
  eq(projects.visibility, 'published'),
);

/**
 * Current versions of published projects that declare a reference, one page in
 * project ID order. Hidden, quarantined, and superseded versions never appear.
 */
export async function visibleDeclarations(
  kind: 'model' | 'hardware',
  referenceId: string,
  page: { limit: number; after?: string | undefined } = { limit: DECLARING_PROJECTS_LIMIT },
) {
  const link = kind === 'model'
    ? { table: projectVersionModelRoles, versionId: projectVersionModelRoles.projectVersionId, referenceId: projectVersionModelRoles.modelReferenceId }
    : { table: projectVersionHardware, versionId: projectVersionHardware.projectVersionId, referenceId: projectVersionHardware.hardwareDescriptorId };
  const rows = await db()
    .selectDistinct({ project_id: projects.id, project_version_id: projectVersions.id, slug: projects.slug })
    .from(link.table)
    .innerJoin(projectVersions, eq(projectVersions.id, link.versionId))
    .innerJoin(projects, visibleCurrentProject)
    .where(and(eq(link.referenceId, referenceId), page.after ? gt(projects.id, page.after) : undefined))
    .orderBy(asc(projects.id))
    .limit(page.limit + 1);
  return { items: rows.slice(0, page.limit), has_more: rows.length > page.limit };
}

/**
 * Public safe view of one model reference (BACKEND_PRD section 13.4). A
 * reference that no visible project declares is treated as absent, so a
 * hidden project's declared model is not disclosed by ID.
 */
export async function readModelReference(id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await db()
    .select({
      model_reference_id: modelReferences.id,
      key: modelReferences.key,
      display_name: modelReferences.displayName,
      family: modelReferences.family,
      source_url: modelReferences.sourceUrl,
      license_state: modelReferences.licenseState,
      license_id: modelReferences.licenseId,
      identity_scheme: modelReferences.identityScheme,
    })
    .from(modelReferences)
    .where(eq(modelReferences.id, id));
  if (!row) return null;
  const declared_by = await visibleDeclarations('model', id);
  if (!declared_by.items.length) return null;
  return {
    ...row,
    declared_by,
    note: 'An external pointer derived from project declarations. No weights are hosted and no local model identity is resolved.',
  };
}

/** Public coarse view of one hardware descriptor and the projects that declare it. */
export async function readHardwareDescriptor(id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await db()
    .select({
      hardware_descriptor_id: hardwareDescriptors.id,
      key: hardwareDescriptors.key,
      display_name: hardwareDescriptors.displayName,
      platform: hardwareDescriptors.platform,
      cpu_architecture: hardwareDescriptors.cpuArchitecture,
      accelerator: hardwareDescriptors.accelerator,
      memory_bytes: hardwareDescriptors.memoryBytes,
      vram_bytes: hardwareDescriptors.vramBytes,
      unified_memory: hardwareDescriptors.unifiedMemory,
      docs_url: hardwareDescriptors.docsUrl,
    })
    .from(hardwareDescriptors)
    .where(eq(hardwareDescriptors.id, id));
  if (!row) return null;
  const declared_by = await visibleDeclarations('hardware', id);
  if (!declared_by.items.length) return null;
  return {
    ...row,
    declared_by,
    note: 'Coarse public descriptor. Declared figures are creator claims, not observed measurements, and no private machine profile is stored.',
  };
}
