CREATE TABLE "build_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"project_version_id" uuid NOT NULL,
	"configuration_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"fingerprint" text NOT NULL,
	"reproducibility" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"public_projection" jsonb,
	"public_projection_digest" text,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"parent_build_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_configurations_owner_digest_uq" UNIQUE("owner_user_id","content_digest"),
	CONSTRAINT "build_configurations_id_owner_version_uq" UNIQUE("id","owner_user_id","project_version_id"),
	CONSTRAINT "build_configurations_visibility_check" CHECK ("build_configurations"."visibility" in ('private', 'public', 'withdrawn')),
	CONSTRAINT "build_configurations_reproducibility_check" CHECK ("build_configurations"."reproducibility" in ('incomplete', 'partial', 'complete')),
	CONSTRAINT "build_configurations_public_has_projection_check" CHECK ("build_configurations"."visibility" <> 'public' or ("build_configurations"."public_projection" is not null and "build_configurations"."published_at" is not null)),
	CONSTRAINT "build_configurations_withdrawn_check" CHECK (("build_configurations"."visibility" = 'withdrawn') = ("build_configurations"."withdrawn_at" is not null)),
	CONSTRAINT "build_configurations_digest_format_check" CHECK ("build_configurations"."content_digest" ~ '^sha256:[0-9a-f]{64}$' and "build_configurations"."fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "compatibility_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"project_version_id" uuid NOT NULL,
	"configuration_key" text NOT NULL,
	"subject_fingerprint" text NOT NULL,
	"subject" jsonb NOT NULL,
	"test_definition_id" uuid,
	"scope" text NOT NULL,
	"evidence_level" text NOT NULL,
	"counts" jsonb NOT NULL,
	"distinct_contributors" integer NOT NULL,
	"conflict" boolean NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"latest_report_at" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compatibility_summaries_scope_check" CHECK ("compatibility_summaries"."scope" in ('component', 'manual')),
	CONSTRAINT "compatibility_summaries_level_check" CHECK ("compatibility_summaries"."evidence_level" in ('community_reported', 'reproducible_test')),
	CONSTRAINT "compatibility_summaries_contributors_check" CHECK ("compatibility_summaries"."distinct_contributors" >= 1)
);
--> statement-breakpoint
CREATE TABLE "evidence_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_report_id" uuid NOT NULL,
	"reviewer_user_id" text,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"evidence_level" text,
	"server_checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_reviews_decision_check" CHECK ("evidence_reviews"."decision" in ('accepted', 'rejected')),
	CONSTRAINT "evidence_reviews_level_check" CHECK ("evidence_reviews"."evidence_level" is null or "evidence_reviews"."evidence_level" in ('community_reported', 'reproducible_test'))
);
--> statement-breakpoint
CREATE TABLE "run_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"submitter_user_id" text NOT NULL,
	"client_run_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"content_digest" text NOT NULL,
	"project_id" uuid NOT NULL,
	"project_version_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"test_definition_id" uuid,
	"payload" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"validation_state" text DEFAULT 'pending' NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"evidence_level" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"public_projection" jsonb,
	"public_projection_digest" text,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_reports_submitter_run_uq" UNIQUE("submitter_user_id","client_run_id"),
	CONSTRAINT "run_reports_submitter_content_uq" UNIQUE("submitter_user_id","content_digest"),
	CONSTRAINT "run_reports_kind_check" CHECK ("run_reports"."kind" in ('manual_build', 'test_run')),
	CONSTRAINT "run_reports_review_state_check" CHECK ("run_reports"."review_state" in ('pending', 'accepted', 'rejected', 'withdrawn')),
	CONSTRAINT "run_reports_visibility_check" CHECK ("run_reports"."visibility" in ('private', 'public', 'withdrawn')),
	CONSTRAINT "run_reports_validation_state_check" CHECK ("run_reports"."validation_state" in ('pending', 'valid', 'invalid')),
	CONSTRAINT "run_reports_definition_discriminator_check" CHECK (("run_reports"."kind" = 'test_run') = ("run_reports"."test_definition_id" is not null)),
	CONSTRAINT "run_reports_evidence_level_check" CHECK ("run_reports"."evidence_level" is null or "run_reports"."evidence_level" in ('community_reported', 'reproducible_test')),
	CONSTRAINT "run_reports_evidence_requires_acceptance_check" CHECK ("run_reports"."evidence_level" is null or "run_reports"."review_state" = 'accepted'),
	CONSTRAINT "run_reports_manual_cap_check" CHECK ("run_reports"."kind" <> 'manual_build' or "run_reports"."evidence_level" is null or "run_reports"."evidence_level" = 'community_reported'),
	CONSTRAINT "run_reports_public_has_projection_check" CHECK ("run_reports"."visibility" <> 'public' or ("run_reports"."public_projection" is not null and "run_reports"."published_at" is not null)),
	CONSTRAINT "run_reports_withdrawn_check" CHECK (("run_reports"."visibility" = 'withdrawn') = ("run_reports"."withdrawn_at" is not null)),
	CONSTRAINT "run_reports_digest_format_check" CHECK ("run_reports"."request_digest" ~ '^sha256:[0-9a-f]{64}$' and "run_reports"."content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "test_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"project_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"configuration_key" text NOT NULL,
	"scope" text NOT NULL,
	"harness" text NOT NULL,
	"model_role" text NOT NULL,
	"required_capabilities" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"fixture_digest" text NOT NULL,
	"evaluator_digest" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"executable" boolean NOT NULL,
	"refusal_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_definitions_version_key_uq" UNIQUE("project_version_id","key"),
	CONSTRAINT "test_definitions_id_version_uq" UNIQUE("id","project_version_id"),
	CONSTRAINT "test_definitions_digest_format_check" CHECK ("test_definitions"."manifest_digest" ~ '^sha256:[0-9a-f]{64}$' and "test_definitions"."fixture_digest" ~ '^sha256:[0-9a-f]{64}$' and "test_definitions"."evaluator_digest" ~ '^sha256:[0-9a-f]{64}$' and "test_definitions"."bundle_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "test_definitions_executable_refusal_check" CHECK ("test_definitions"."executable" or jsonb_array_length("test_definitions"."refusal_codes") > 0)
);
--> statement-breakpoint
ALTER TABLE "build_configurations" ADD CONSTRAINT "build_configurations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_configurations" ADD CONSTRAINT "build_configurations_version_belongs_fk" FOREIGN KEY ("project_version_id","project_id") REFERENCES "public"."project_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_configurations" ADD CONSTRAINT "build_configurations_parent_fk" FOREIGN KEY ("parent_build_id") REFERENCES "public"."build_configurations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_summaries" ADD CONSTRAINT "compatibility_summaries_version_belongs_fk" FOREIGN KEY ("project_version_id","project_id") REFERENCES "public"."project_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_summaries" ADD CONSTRAINT "compatibility_summaries_definition_belongs_fk" FOREIGN KEY ("test_definition_id","project_version_id") REFERENCES "public"."test_definitions"("id","project_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_reviews" ADD CONSTRAINT "evidence_reviews_run_report_id_run_reports_id_fk" FOREIGN KEY ("run_report_id") REFERENCES "public"."run_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_reviews" ADD CONSTRAINT "evidence_reviews_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reports" ADD CONSTRAINT "run_reports_submitter_user_id_user_id_fk" FOREIGN KEY ("submitter_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reports" ADD CONSTRAINT "run_reports_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reports" ADD CONSTRAINT "run_reports_version_belongs_fk" FOREIGN KEY ("project_version_id","project_id") REFERENCES "public"."project_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reports" ADD CONSTRAINT "run_reports_build_owned_fk" FOREIGN KEY ("build_id","submitter_user_id","project_version_id") REFERENCES "public"."build_configurations"("id","owner_user_id","project_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reports" ADD CONSTRAINT "run_reports_test_definition_belongs_fk" FOREIGN KEY ("test_definition_id","project_version_id") REFERENCES "public"."test_definitions"("id","project_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_definitions" ADD CONSTRAINT "test_definitions_version_belongs_fk" FOREIGN KEY ("project_version_id","project_id") REFERENCES "public"."project_versions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_configurations_owner_idx" ON "build_configurations" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "build_configurations_project_visibility_idx" ON "build_configurations" USING btree ("project_id","visibility","published_at");--> statement-breakpoint
CREATE INDEX "build_configurations_fingerprint_idx" ON "build_configurations" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "compatibility_summaries_test_uidx" ON "compatibility_summaries" USING btree ("project_version_id","configuration_key","subject_fingerprint","test_definition_id") WHERE "compatibility_summaries"."test_definition_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "compatibility_summaries_manual_uidx" ON "compatibility_summaries" USING btree ("project_version_id","configuration_key","subject_fingerprint") WHERE "compatibility_summaries"."test_definition_id" is null;--> statement-breakpoint
CREATE INDEX "compatibility_summaries_project_idx" ON "compatibility_summaries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_reviews_report_idx" ON "evidence_reviews" USING btree ("run_report_id","created_at");--> statement-breakpoint
CREATE INDEX "run_reports_submitter_idx" ON "run_reports" USING btree ("submitter_user_id","created_at");--> statement-breakpoint
CREATE INDEX "run_reports_project_state_idx" ON "run_reports" USING btree ("project_id","review_state","visibility");--> statement-breakpoint
CREATE INDEX "run_reports_build_idx" ON "run_reports" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "run_reports_validation_idx" ON "run_reports" USING btree ("validation_state","created_at");--> statement-breakpoint
CREATE INDEX "test_definitions_project_idx" ON "test_definitions" USING btree ("project_id");