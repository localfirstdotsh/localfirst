CREATE TABLE "publication_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"client_id" text NOT NULL,
	"enabled_by_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_delegations_consent_uq" UNIQUE("consent_id")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "created_by_client_id" text;--> statement-breakpoint
ALTER TABLE "project_versions" ADD COLUMN "publication_authorization" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_versions" ADD COLUMN "published_via_client_name" text;--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD COLUMN "authorization_kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "publication_delegations" ADD CONSTRAINT "publication_delegations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_delegations" ADD CONSTRAINT "publication_delegations_consent_id_oauth_consent_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."oauth_consent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_delegations_user_client_idx" ON "publication_delegations" USING btree ("user_id","client_id");--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_publication_authorization_check" CHECK ("project_versions"."publication_authorization" in ('human', 'delegated'));--> statement-breakpoint
ALTER TABLE "publication_approvals" ADD CONSTRAINT "publication_approvals_authorization_check" CHECK (("publication_approvals"."authorization_kind" = 'human' and "publication_approvals"."client_id" is null) or ("publication_approvals"."authorization_kind" = 'delegated' and "publication_approvals"."client_id" is not null));