# Frontend architecture and design system

The public website uses Next.js App Router, React and plain CSS. Preserve the
command-first visual identity and the behavior defined in `../../docs/product/FRONTEND_PRD.md`.
This package owns every browser screen, including authenticated account, consent and
publication review. The backend retains session, ownership and mutation enforcement.

```text
src/
  app/                    Next route composition, metadata, errors, health and SEO
    styles/               Global base styles and shared layout patterns
    design-system/        Opt-in production-component gallery and its example styles
  features/
    catalog/              URL filters, search, responsive rail and project results
    projects/             Requirements action/validation, evidence and exact-version presentation
      index.ts            Explicit cross-feature evidence presentation export
    references/           Model/hardware catalogs and their registry error handling
    connect/              Deployment-aware connection setup
    auth/                 Sign-in, original-query OAuth consent and permission presentation
    account/              Connections/devices, owned projects/usage and deletion
    review/               Exact-artifact inspection, acknowledgements and approval lifecycle
  components/
    ui/                   Button, Input, Checkbox, Badge and shared choice controls
    composites/           FormField, PageHeader, StatePanel, CommandBlock and PendingPage
    layout/               SiteHeader, navigation and PageContainer
  design-system/          Semantic tokens and responsive breakpoint definitions
  lib/                    Registry transport/response schemas, shared query contracts,
                          formatting and deployment configuration
```

## Ownership and dependencies

Routes may import features and shared components. Features may import their own
implementation, shared components, tokens and infrastructure. A feature may use
another feature only through its explicit `index.ts` public interface; today
catalog rows reuse the project's EvidenceBadge that way. Keep those exports small
and named. Shared components never import features or routes, primitives never
import composites/layouts, and infrastructure/tokens never import UI or features.
No wildcard export chains or local import aliases are used.

The shared registry response schemas, URL query contract and formatter remain in
`lib/` because catalog, reference pages, transport, SEO and project pages all use
them. API reads retain their original caching, schema validation, visitor-IP and
error behavior. The project action retains its server directive, pinned version
and no-store POST. Feature behavior belongs there, not in a reusable UI control.
Model and hardware row contents stay separate because their fields and unknown
states have different meanings. No modal, tabs, custom dropdown, theme toggle or
skeleton library is introduced: there are no existing production consumers.

`src/architecture.test.ts`, run by the normal `test` script, parses TypeScript
imports/exports and CSS imports. It checks dependency direction, explicit feature
interfaces, missing imports, circular imports (including types), breakpoint
agreement and inline visual styles. Update its rules with any intentional new
boundary. TypeScript is already a dependency; no architecture package is needed.

## Naming and new code

Use PascalCase for component files and names, kebab-case for ordinary TypeScript
modules, lower-case feature folders, and the Next-required names for route files.
Colocate `.test.ts(x)` with the implementation. Import the implementation directly
within its owner; introduce a named feature export only for justified cross-feature
reuse. Read the installed Next docs specified in `AGENTS.md` before route changes.

For a new feature, create `features/<domain>/` only when it owns real domain behavior.
Keep route metadata and Next exports in `app/`; put domain rendering, stateful
behavior, validation and actions in the feature. Use ordinary functions for pure
logic. Keep existing server/client boundaries; do not turn an entire route into a
client component to reuse an interactive child.

Before creating a reusable component, inspect the existing primitives and patterns.
Extract a shared responsibility with real consumers, not similar-looking JSX.
Use native element props so form ownership, refs, disabled state and browser
keyboard behavior survive composition. Keep API requests and permissions out of
shared UI. Add interaction coverage when extracting behavior.

## Tokens, CSS and component usage

`src/design-system/tokens.css` is the canonical palette and foundation scale.
The shared dark palette applies to every public and private page. Inter is self-hosted from `src/design-system/assets` with its license.
Use `--bg`, `--card`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--link`,
`--warn`, `--error`, `--success` and `--focus` by meaning. Reuse `--space-*`,
`--text-*`, `--width-*`, `--radius*` and control-size tokens for geometry.
Existing small spacing steps are preserved for visual parity. Surfaces are flat
and interactions immediate; do not add shadows or transitions without a product need.
Disabled controls use the shared disabled opacity, and invalid controls use the error border.

`app/globals.css` imports the tokens, base, UI, composites, layout patterns and
feature CSS in an explicit order. Existing global class APIs are retained to avoid
cascade regressions. Keep feature selectors descriptive (`catalog-*`, `project-*`,
`check-*`, `document-*`, `filters-*`); use scoped CSS Modules for new isolated
styling when appropriate. New visual values belong in tokens, not JSX style objects.
CSS custom properties cannot be used in media queries: `design-system/breakpoints.ts`
defines 600px and 900px boundaries and the architecture test checks the CSS literals.
Reduced motion, forced colors and visible focus are part of the base styles.

- **Button:** default/primary, default/small. Defaults to `type="button"`; use
  `type="submit"` for a form. `loading` disables the button and sets `aria-busy`;
  supply meaningful pending text. Links use `buttonClassName()` with native anchors
  or Next Link to retain download/prefetch/navigation semantics. Existing class
  names remain the same shared CSS API.
- **Input / Select / Checkbox:** native elements with shared styling and full native
  attributes, including the HTML `form` association used by the catalog. Select
  uses native options and keyboard behavior. Checkbox includes its text label.
- **FormField:** supplies a label with `htmlFor`, optional help (`<id>-help`) and
  error (`<id>-error`). Give the control that `id`; set `aria-invalid` and
  `aria-describedby` when displaying validation/help. The feature owns validation.
- **StatePanel:** neutral status or warning alert, optional request ID, and h1/h2/h3
  heading levels. Keep existing error messages and recovery actions. Use h1 only
  for a whole-page state, h3 under a section heading.
- **PageContainer / PageHeader:** existing page widths and vertical spacing, with
  explicit variants. PageHeader owns the reference page's title/description pattern.
- **Panels/cards:** `.panel` defines the shared surface, border, padding and radius.
  Compose feature content inside it; do not introduce a generic business-data card.
- **CommandBlock:** selection and clipboard feedback shared by setup/toolkit pages.
  Commands are text, never executed. Clipboard failure selects text for manual copy.
- **Badge / EvidenceBadge:** Badge is a generic UI surface. EvidenceBadge is project
  domain presentation with exact evidence labels, not a generic status mapper.

## One public origin

All browser routes live here: `/sign-in`, `/consent`, `/account/*`,
`/review/drafts/<id>` and `/privacy`, alongside the public catalog. API/auth,
MCP, OAuth discovery and schema requests use runtime route handlers that proxy
to `LOCALFIRST_API_URL`, the distinct private backend address. Browser links
stay on the website origin. Previously issued backend page URLs redirect to the
website with their path/query intact; no legacy HTML renderer remains. The proxy uses native HTTP streaming to preserve
the public Host required by MCP DNS-rebinding checks, raw response bodies,
redirect status and individual Set-Cookie headers. It rejects foreign-origin
cookie-authenticated browser mutations; backend guards remain authoritative.

Set backend `API_BASE_URL` and `WEBSITE_URL`, plus web `LOCALFIRST_SITE_URL`,
to the same public website origin. Register the GitHub callback under that
origin (`/api/auth/callback/github`). `LOCALFIRST_PUBLIC_API_URL` defaults to
the website origin; if explicitly set for downloads, use the same public origin
for a unified deployment. Keep `LOCALFIRST_API_URL` private and distinct to
avoid proxy recursion. The website does not receive DB credentials or auth secrets.
Changing an existing public issuer requires coordinating OAuth callbacks and
existing client credentials; code changes do not perform that deployment.

Server-rendered private pages fetch only session-only `/api/browser/*` JSON
read models with `cache: no-store`; cookies never enter public cached reads.
Anonymous private pages redirect to sign-in with a validated local continuation;
foreign records remain 404. Sensitive pages receive nonce CSP via `src/proxy.ts`,
no-referrer and no-store behavior. The backend supplies authoritative approval
state and validates every mutation. The UI submits exact revision/digest and
acknowledgements, displays confirmed approval separately from publication, and
handles denial, expiry, stale changes and uncertain request recovery.

## Component gallery

Run `pnpm build:contracts` then `pnpm --filter @localfirst/web dev` and visit
`http://localhost:3000/design-system`. For a production server, opt in with
`LOCALFIRST_DESIGN_SYSTEM=true` at runtime. Without it the route returns 404 outside
development. It has no navigation/sitemap entry and sets noindex/nofollow.

Examples import production components and styles. Inspect actions, native fields,
validation, selection, clipboard feedback, panels, neutral/error feedback, evidence,
disclosures, typography and tokens. Use Tab for focus, Space/Enter for activation,
a pointer for hover, and your system/browser color-scheme setting for both themes.
Add examples when a new shared component has a real production consumer.

## Validation

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:contracts
pnpm --filter @localfirst/web typecheck
pnpm --filter @localfirst/web build
pnpm --filter @localfirst/web test
pnpm test:e2e
```

The browser runner builds services, creates/migrates/seeds the dedicated
`localfirst_web_e2e` database, starts real servers, tests Chromium desktop and phone
viewports, and drops that database afterwards. It requires local PostgreSQL and
Chromium (`pnpm --filter @localfirst/web exec playwright install chromium`).
`E2E_ADMIN_DATABASE_URL` may override the local admin connection. Set
`BROWSER_SCREENSHOTS_DIR=/tmp/localfirst-browser-screenshots` to capture the
auth/account/privacy/review reference pages during browser tests. Never point this
runner or integration tests at development/deployed data. There is no ESLint script;
TypeScript and the architecture suite provide static checks.

## Public entry and catalog preview

The public homepage provides a connection command, client setup links, and docs.
Shared project and exact-version URLs remain readable without a catalog. The sitemap
lists public setup/docs pages, without enumerating projects.

`LOCALFIRST_CATALOG_PREVIEW=true` enables the retained `/projects`, `/models`,
`/hardware`, and `/builds` screens for preview deployments. It is opt-in even in
development, read at request time, unlinked from the public header, and noindex.
Without that exact setting these routes redirect to `/docs`; it does not change
API/MCP access or project visibility. Browser tests opt into this setting on their
legacy catalog fixtures and exercise the public default on the unreleased server.
