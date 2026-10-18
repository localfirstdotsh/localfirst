CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"refreshId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"resourceId" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"clientDiscoveryId" text,
	"disabled" boolean,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" jsonb,
	"clientCredentialsScopes" jsonb,
	"userId" text,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" jsonb,
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" jsonb NOT NULL,
	"postLogoutRedirectUris" jsonb,
	"backchannelLogoutUri" text,
	"backchannelLogoutSessionRequired" boolean,
	"tokenEndpointAuthMethod" text,
	"applicationType" text,
	"jwks" text,
	"jwksUri" text,
	"grantTypes" jsonb,
	"responseTypes" jsonb,
	"requirePKCE" boolean,
	"dpopBoundAccessTokens" boolean,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"scopes" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text NOT NULL,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" jsonb,
	"requestedUserInfoClaims" jsonb,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"rotatedAt" timestamp with time zone,
	"rotationReplayResponse" text,
	"rotationReplayExpiresAt" timestamp with time zone,
	"authTime" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"accessTokenTtl" integer,
	"refreshTokenTtl" integer,
	"signingAlgorithm" text,
	"signingKeyId" text,
	"allowedScopes" jsonb,
	"customClaims" jsonb,
	"dpopBoundAccessTokensRequired" boolean,
	"disabled" boolean,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"policyVersion" integer,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"relationship" text NOT NULL,
	"user_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "attributions_role_check" CHECK ("attributions"."role" in ('author', 'submitter', 'curator'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_client_id" text,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"policy_version" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requester_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"evidence" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_requests_kind_check" CHECK ("claim_requests"."kind" in ('manager', 'author')),
	CONSTRAINT "claim_requests_state_check" CHECK ("claim_requests"."state" in ('pending', 'accepted', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'editable' NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_generation" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"manifest" jsonb,
	"markdown" text,
	"derived" jsonb,
	"content_digest" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warning_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"import_descriptor" jsonb,
	"import_error" jsonb,
	"operation_id" uuid,
	"published_version_id" uuid,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_kind_check" CHECK ("drafts"."kind" in ('project', 'build', 'test_result')),
	CONSTRAINT "drafts_state_check" CHECK ("drafts"."state" in ('editable', 'ready_for_review', 'approved', 'published', 'ingesting', 'ingestion_failed', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "hardware_descriptors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text,
	"cpu_architecture" text,
	"accelerator" text,
	"memory_bytes" bigint,
	"vram_bytes" bigint,
	"unified_memory" boolean,
	"docs_url" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_key" text NOT NULL,
	"operation" text NOT NULL,
	"target_key" text DEFAULT '' NOT NULL,
	"key_hash" text NOT NULL,
	"request_digest" text NOT NULL,
	"state" text DEFAULT 'in_flight' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"operation_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_scope_uq" UNIQUE("actor_key","operation","target_key","key_hash"),
	CONSTRAINT "idempotency_records_state_check" CHECK ("idempotency_records"."state" in ('in_flight', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" text,
	"operation_id" uuid,
	"dedupe_key" text,
	"last_error_code" text,
	"last_error_message" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "model_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"family" text,
	"source_url" text,
	"license_state" text DEFAULT 'unknown' NOT NULL,
	"license_id" text,
	"identity_scheme" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"actor_user_id" text,
	"actor_client_id" text,
	"required_scope" text,
	"target_kind" text,
	"target_id" text,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_state_check" CHECK ("operations"."state" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "operator_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" text,
	"granted_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_roles_role_check" CHECK ("operator_roles"."role" in ('moderator', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_kind" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_version_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_digest" text NOT NULL,
	CONSTRAINT "project_version_files_path_uq" UNIQUE("project_version_id","path"),
	CONSTRAINT "project_version_files_kind_check" CHECK ("project_version_files"."kind" in ('test_manifest', 'fixture', 'other'))
);
--> statement-breakpoint
CREATE TABLE "project_version_hardware" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"hardware_descriptor_id" uuid NOT NULL,
	"relation" text DEFAULT 'declared_requirement' NOT NULL,
	CONSTRAINT "project_version_hardware_uq" UNIQUE("project_version_id","hardware_descriptor_id")
);
--> statement-breakpoint
CREATE TABLE "project_version_model_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"required_capabilities" jsonb NOT NULL,
	"minimum_context_tokens" integer,
	"substitution" text NOT NULL,
	"model_reference_id" uuid,
	"preferred_hint" text,
	CONSTRAINT "project_version_model_roles_uq" UNIQUE("project_version_id","role_key")
);
--> statement-breakpoint
CREATE TABLE "project_version_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"runtime_reference_id" uuid NOT NULL,
	"version_constraint" text,
	CONSTRAINT "project_version_runtimes_uq" UNIQUE("project_version_id","runtime_reference_id")
);
--> statement-breakpoint
CREATE TABLE "project_version_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"schema_id" text NOT NULL,
	"path" text NOT NULL,
	"harness" text NOT NULL,
	"scope" text NOT NULL,
	"configuration_key" text NOT NULL,
	"model_role" text NOT NULL,
	"required_capabilities" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"fixture_digest" text NOT NULL,
	"runner_available" boolean DEFAULT false NOT NULL,
	CONSTRAINT "project_version_tests_key_uq" UNIQUE("project_version_id","key")
);
--> statement-breakpoint
CREATE TABLE "project_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"spec_version" text NOT NULL,
	"schema_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"content_digest" text NOT NULL,
	"payload_digest" text NOT NULL,
	"derived" jsonb NOT NULL,
	"warning_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_by_user_id" text NOT NULL,
	"published_from_draft_id" uuid,
	"approval_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_versions_project_number_uq" UNIQUE("project_id","version_number"),
	CONSTRAINT "project_versions_project_digest_uq" UNIQUE("project_id","content_digest"),
	CONSTRAINT "project_versions_id_project_uq" UNIQUE("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"project_key" text NOT NULL,
	"manager_user_id" text NOT NULL,
	"type" text NOT NULL,
	"visibility" text DEFAULT 'published' NOT NULL,
	"listing_origin" text NOT NULL,
	"current_version_id" uuid,
	"quarantined_at" timestamp with time zone,
	"quarantine_reason" text,
	"unpublished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_visibility_check" CHECK ("projects"."visibility" in ('published', 'unpublished', 'quarantined')),
	CONSTRAINT "projects_listing_origin_check" CHECK ("projects"."listing_origin" in ('creator_submitted', 'curated_from_upstream'))
);
--> statement-breakpoint
CREATE TABLE "publication_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"payload_digest" text NOT NULL,
	"acknowledged_warning_codes" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"decision" text DEFAULT 'approved' NOT NULL,
	"session_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_operation_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_approvals_decision_check" CHECK ("publication_approvals"."decision" in ('approved', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family" text NOT NULL,
	"display_name" text NOT NULL,
	"api_profile" text,
	"support_status" text DEFAULT 'declared_only' NOT NULL,
	"docs_url" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_references_support_check" CHECK ("runtime_references"."support_status" in ('supported', 'declared_only', 'unsupported'))
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"project_version_id" uuid NOT NULL,
	"visibility" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"type" text NOT NULL,
	"categories" jsonb NOT NULL,
	"runtime_families" jsonb NOT NULL,
	"architectures" jsonb NOT NULL,
	"operating_systems" jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"model_keys" jsonb NOT NULL,
	"hardware_keys" jsonb NOT NULL,
	"test_support" text NOT NULL,
	"evidence_level" text NOT NULL,
	"offline_declared" text NOT NULL,
	"license_state" text NOT NULL,
	"listing_origin" text NOT NULL,
	"sources_pinned" boolean NOT NULL,
	"search_vector" "tsvector",
	"project_updated_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_drift_checks" (
	"source_reference_id" uuid PRIMARY KEY NOT NULL,
	"last_checked_at" timestamp with time zone,
	"observed_upstream_revision" text,
	"pinned_revision_available" boolean,
	"source_visibility" text,
	"error_class" text,
	"next_check_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"revision" text,
	"content_digest" text,
	"path" text,
	"provider_name" text,
	"provider_repo_id" text,
	"provider_owner" text,
	"provider_repo" text,
	"license_state" text,
	"license_id" text,
	"license_reference" text,
	"note" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_references_version_key_uq" UNIQUE("project_version_id","key")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"external_identities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"deletion_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refreshId_oauth_refresh_token_id_fk" FOREIGN KEY ("refreshId") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resourceId_oauth_resource_identifier_fk" FOREIGN KEY ("resourceId") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_requests" ADD CONSTRAINT "claim_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_requests" ADD CONSTRAINT "claim_requests_requester_user_id_user_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_requests" ADD CONSTRAINT "claim_requests_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_published_version_id_project_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_roles" ADD CONSTRAINT "operator_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_roles" ADD CONSTRAINT "operator_roles_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_files" ADD CONSTRAINT "project_version_files_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_hardware" ADD CONSTRAINT "project_version_hardware_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_hardware" ADD CONSTRAINT "project_version_hardware_hardware_descriptor_id_hardware_descriptors_id_fk" FOREIGN KEY ("hardware_descriptor_id") REFERENCES "public"."hardware_descriptors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_model_roles" ADD CONSTRAINT "project_version_model_roles_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_model_roles" ADD CONSTRAINT "project_version_model_roles_model_reference_id_model_references_id_fk" FOREIGN KEY ("model_reference_id") REFERENCES "public"."model_references"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_runtimes" ADD CONSTRAINT "project_version_runtimes_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_runtimes" ADD CONSTRAINT "project_version_runtimes_runtime_reference_id_runtime_references_id_fk" FOREIGN KEY ("runtime_reference_id") REFERENCES "public"."runtime_references"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_tests" ADD CONSTRAINT "project_version_tests_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_published_by_user_id_user_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_user_id_user_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD CONSTRAINT "publication_approvals_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD CONSTRAINT "publication_approvals_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_drift_checks" ADD CONSTRAINT "source_drift_checks_source_reference_id_source_references_id_fk" FOREIGN KEY ("source_reference_id") REFERENCES "public"."source_references"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_references" ADD CONSTRAINT "source_references_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" USING btree ("clientId","resourceId");--> statement-breakpoint
CREATE INDEX "attributions_version_idx" ON "attributions" USING btree ("project_version_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_kind","target_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_requests_pending_uidx" ON "claim_requests" USING btree ("project_id","requester_user_id") WHERE "claim_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "claim_requests_state_idx" ON "claim_requests" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "drafts_owner_state_idx" ON "drafts" USING btree ("owner_user_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "drafts_project_idx" ON "drafts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hardware_descriptors_key_uidx" ON "hardware_descriptors" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uidx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "model_references_key_uidx" ON "model_references" USING btree ("key");--> statement-breakpoint
CREATE INDEX "operations_actor_idx" ON "operations" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "operations_state_idx" ON "operations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_roles_active_uidx" ON "operator_roles" USING btree ("user_id","role") WHERE "operator_roles"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "project_version_hardware_descriptor_idx" ON "project_version_hardware" USING btree ("hardware_descriptor_id");--> statement-breakpoint
CREATE INDEX "project_version_model_roles_model_idx" ON "project_version_model_roles" USING btree ("model_reference_id");--> statement-breakpoint
CREATE INDEX "project_version_runtimes_runtime_idx" ON "project_version_runtimes" USING btree ("runtime_reference_id");--> statement-breakpoint
CREATE INDEX "project_versions_project_published_idx" ON "project_versions" USING btree ("project_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uidx" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_manager_key_uidx" ON "projects" USING btree ("manager_user_id","project_key");--> statement-breakpoint
CREATE INDEX "projects_visibility_updated_idx" ON "projects" USING btree ("visibility","updated_at");--> statement-breakpoint
CREATE INDEX "publication_approvals_lookup_idx" ON "publication_approvals" USING btree ("draft_id","draft_revision","payload_digest","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_approvals_active_uidx" ON "publication_approvals" USING btree ("draft_id") WHERE "publication_approvals"."consumed_at" is null and "publication_approvals"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "rate_limit_counters_expiry_idx" ON "rate_limit_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_references_family_uidx" ON "runtime_references" USING btree ("family");--> statement-breakpoint
CREATE INDEX "search_documents_vector_idx" ON "search_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "search_documents_visibility_idx" ON "search_documents" USING btree ("visibility","project_updated_at");--> statement-breakpoint
CREATE INDEX "search_documents_type_idx" ON "search_documents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "search_documents_test_support_idx" ON "search_documents" USING btree ("test_support");--> statement-breakpoint
CREATE INDEX "search_documents_categories_idx" ON "search_documents" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "search_documents_runtimes_idx" ON "search_documents" USING gin ("runtime_families");--> statement-breakpoint
CREATE INDEX "search_documents_architectures_idx" ON "search_documents" USING gin ("architectures");--> statement-breakpoint
CREATE INDEX "search_documents_os_idx" ON "search_documents" USING gin ("operating_systems");--> statement-breakpoint
CREATE INDEX "search_documents_models_idx" ON "search_documents" USING gin ("model_keys");--> statement-breakpoint
CREATE INDEX "search_documents_hardware_idx" ON "search_documents" USING gin ("hardware_keys");--> statement-breakpoint
CREATE INDEX "source_drift_checks_next_idx" ON "source_drift_checks" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "source_references_provider_idx" ON "source_references" USING btree ("provider_name","provider_repo_id","path");--> statement-breakpoint
CREATE INDEX "source_references_url_idx" ON "source_references" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_handle_uidx" ON "user_profiles" USING btree (lower("handle"));