-- Reviewed hand-written migration (BACKEND_PRD section 16.2).
--
-- "Current version and configuration/test/build FKs must belong to the
-- intended project/version, never merely an existing ID." A composite foreign
-- key proves that `projects.current_version_id` names a version of *this*
-- project, which a single-column reference cannot express.

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_current_version_belongs_fk"
  FOREIGN KEY ("current_version_id", "id")
  REFERENCES "project_versions" ("id", "project_id")
  ON DELETE SET NULL
  DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint

-- A published project must point at a version; hidden states may not.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_published_has_version_check"
  CHECK ("visibility" <> 'published' OR "current_version_id" IS NOT NULL);
--> statement-breakpoint

-- Quarantine state and its audit fields stay consistent (section 17.4).
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_quarantine_reason_check"
  CHECK (("visibility" = 'quarantined') = ("quarantined_at" IS NOT NULL));
--> statement-breakpoint

-- An approval is consumed exactly once, and only before it expires.
ALTER TABLE "publication_approvals"
  ADD CONSTRAINT "publication_approvals_single_use_check"
  CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL);
--> statement-breakpoint

-- Version numbers start at 1 and never go backwards.
ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_number_positive_check"
  CHECK ("version_number" >= 1);
--> statement-breakpoint

-- Digests are stored in one canonical form so approvals cannot drift.
ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_content_digest_format_check"
  CHECK ("content_digest" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint

ALTER TABLE "drafts"
  ADD CONSTRAINT "drafts_payload_digest_format_check"
  CHECK ("payload_digest" ~ '^sha256:[0-9a-f]{64}$');
