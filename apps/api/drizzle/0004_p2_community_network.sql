CREATE TABLE "community_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" text,
	"review_reason" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_records_kind_check" CHECK ("community_records"."kind" in ('collection', 'troubleshooting')),
	CONSTRAINT "community_records_visibility_check" CHECK ("community_records"."visibility" in ('private', 'public', 'withdrawn', 'quarantined')),
	CONSTRAINT "community_records_review_check" CHECK ("community_records"."review_state" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "community_records_review_provenance_check" CHECK ("community_records"."review_state" = 'pending' or ("community_records"."reviewed_by_user_id" is not null and "community_records"."review_reason" is not null and "community_records"."reviewed_by_user_id" <> "community_records"."owner_user_id")),
	CONSTRAINT "community_records_public_check" CHECK ("community_records"."visibility" <> 'public' or "community_records"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "derivative_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"child_project_id" uuid NOT NULL,
	"child_version_id" uuid NOT NULL,
	"parent_project_id" uuid NOT NULL,
	"parent_version_id" uuid NOT NULL,
	"change_summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derivative_relationships_child_uq" UNIQUE("child_version_id"),
	CONSTRAINT "derivative_relationships_no_self_check" CHECK ("derivative_relationships"."child_project_id" <> "derivative_relationships"."parent_project_id")
);
--> statement-breakpoint
CREATE TABLE "independent_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_report_id" uuid NOT NULL,
	"reproduction_report_id" uuid NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"claim_digest" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "independent_verifications_pair_uq" UNIQUE("original_report_id","reproduction_report_id"),
	CONSTRAINT "independent_verifications_separate_check" CHECK ("independent_verifications"."original_report_id" <> "independent_verifications"."reproduction_report_id"),
	CONSTRAINT "independent_verifications_state_check" CHECK ("independent_verifications"."state" in ('active', 'revoked')),
	CONSTRAINT "independent_verifications_revocation_check" CHECK (("independent_verifications"."state" = 'revoked') = ("independent_verifications"."revoked_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "compatibility_summaries" DROP CONSTRAINT "compatibility_summaries_level_check";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_kind_check";--> statement-breakpoint
ALTER TABLE "community_records" ADD CONSTRAINT "community_records_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_records" ADD CONSTRAINT "community_records_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivative_relationships" ADD CONSTRAINT "derivative_relationships_child_version_id_child_project_id_project_versions_id_project_id_fk" FOREIGN KEY ("child_version_id","child_project_id") REFERENCES "public"."project_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivative_relationships" ADD CONSTRAINT "derivative_relationships_parent_version_id_parent_project_id_project_versions_id_project_id_fk" FOREIGN KEY ("parent_version_id","parent_project_id") REFERENCES "public"."project_versions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_verifications" ADD CONSTRAINT "independent_verifications_original_report_id_run_reports_id_fk" FOREIGN KEY ("original_report_id") REFERENCES "public"."run_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_verifications" ADD CONSTRAINT "independent_verifications_reproduction_report_id_run_reports_id_fk" FOREIGN KEY ("reproduction_report_id") REFERENCES "public"."run_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "independent_verifications" ADD CONSTRAINT "independent_verifications_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_records_public_idx" ON "community_records" USING btree ("kind","visibility","review_state","id");--> statement-breakpoint
CREATE INDEX "community_records_owner_idx" ON "community_records" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "derivative_relationships_parent_idx" ON "derivative_relationships" USING btree ("parent_project_id");--> statement-breakpoint
CREATE INDEX "independent_verifications_reproduction_idx" ON "independent_verifications" USING btree ("reproduction_report_id");--> statement-breakpoint
ALTER TABLE "compatibility_summaries" ADD CONSTRAINT "compatibility_summaries_level_check" CHECK ("compatibility_summaries"."evidence_level" in ('community_reported', 'reproducible_test', 'independently_verified'));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_check" CHECK ("drafts"."kind" in ('project', 'build', 'test_result', 'collection', 'troubleshooting'));--> statement-breakpoint
-- Enforce acyclic immutable lineage even for writes outside application services.
CREATE FUNCTION localfirst_check_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('derivative-lineage', 0));
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'lineage is immutable' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_project_id UNION
      SELECT r.parent_project_id FROM derivative_relationships r JOIN ancestors a ON r.child_project_id = a.id
    ) SELECT 1 FROM ancestors WHERE id = NEW.child_project_id
  ) THEN RAISE EXCEPTION 'lineage cycle' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER derivative_lineage_guard BEFORE INSERT OR UPDATE ON derivative_relationships FOR EACH ROW EXECUTE FUNCTION localfirst_check_lineage();
--> statement-breakpoint
-- Basic reviewer independence is relational; full protocol/provenance qualification is also rechecked on every read.
CREATE FUNCTION localfirst_check_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a run_reports; b run_reports; manager text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.original_report_id <> OLD.original_report_id OR NEW.reproduction_report_id <> OLD.reproduction_report_id OR NEW.reviewer_user_id <> OLD.reviewer_user_id OR NEW.provenance <> OLD.provenance OR NEW.claim_digest <> OLD.claim_digest OR NEW.policy_version <> OLD.policy_version OR OLD.state = 'revoked' AND NEW.state <> 'revoked' THEN
      RAISE EXCEPTION 'verification claim is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM run_reports WHERE id = NEW.original_report_id;
  SELECT * INTO b FROM run_reports WHERE id = NEW.reproduction_report_id;
  SELECT manager_user_id INTO manager FROM projects WHERE id = a.project_id;
  IF a.submitter_user_id = b.submitter_user_id OR NEW.reviewer_user_id IN (a.submitter_user_id, b.submitter_user_id, manager) OR b.submitter_user_id = manager
    OR a.review_state <> 'accepted' OR b.review_state <> 'accepted' OR a.visibility <> 'public' OR b.visibility <> 'public'
    OR a.evidence_level <> 'reproducible_test' OR b.evidence_level <> 'reproducible_test'
    OR a.project_version_id <> b.project_version_id OR a.test_definition_id <> b.test_definition_id
    OR NEW.policy_version <> 'localfirst/independence/v0.1'
  THEN RAISE EXCEPTION 'unqualified independent verification' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER independent_verifier_guard BEFORE INSERT OR UPDATE ON independent_verifications FOR EACH ROW EXECUTE FUNCTION localfirst_check_verifier();
--> statement-breakpoint
CREATE FUNCTION localfirst_check_verified_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_level = 'independently_verified' AND NOT EXISTS (
    SELECT 1 FROM independent_verifications v
    JOIN run_reports a ON a.id = v.original_report_id
    JOIN run_reports b ON b.id = v.reproduction_report_id
    WHERE v.state = 'active' AND a.id::text IN (SELECT jsonb_array_elements_text(NEW.evidence_ids))
      AND a.project_version_id = NEW.project_version_id AND a.test_definition_id = NEW.test_definition_id
      AND a.review_state = 'accepted' AND b.review_state = 'accepted'
      AND a.visibility = 'public' AND b.visibility = 'public'
  ) THEN RAISE EXCEPTION 'verified summary needs qualified separate evidence' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER independent_summary_guard BEFORE INSERT OR UPDATE ON compatibility_summaries FOR EACH ROW EXECUTE FUNCTION localfirst_check_verified_summary();
--> statement-breakpoint
-- Old summaries were built from private build payloads. Drop only derived caches,
-- preserving reports/approvals, and rebuild from approved public projections.
INSERT INTO outbox_events (event_type, aggregate_kind, aggregate_id, payload)
SELECT 'evidence.changed', 'project', project_id::text, '{"cause":"p2.public_projection_policy"}'::jsonb
FROM compatibility_summaries GROUP BY project_id;
--> statement-breakpoint
UPDATE search_documents SET evidence_level = CASE WHEN sources_pinned THEN 'documented' ELSE 'claimed' END, stale = true
WHERE project_id IN (SELECT project_id FROM compatibility_summaries);
--> statement-breakpoint
DELETE FROM compatibility_summaries;
