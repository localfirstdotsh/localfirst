-- The linked approval device is retired (BACKEND_PRD ADR-014). An approval it recorded and nobody used yet is revoked, so none outlives this change.
UPDATE "publication_approvals" SET "revoked_at" = now() WHERE "approver_credential_id" IS NOT NULL AND "consumed_at" IS NULL AND "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "publication_approvals" DROP CONSTRAINT "publication_approvals_approver_credential_id_approver_credentials_id_fk";--> statement-breakpoint
ALTER TABLE "publication_approvals" DROP COLUMN "approver_credential_id";--> statement-breakpoint
DROP TABLE "approver_credentials";--> statement-breakpoint
DROP TABLE "approver_links";
