# Capacity Planner Read-Only API

The Capacity Planner connects to the TA system through this API. It does not
receive a Convex admin key, database credential, or R2 bucket credential. The
API is read-only and only responds to an authenticated server-to-server request.

## Credentials

The TA backend must have `CAPACITY_PLANNER_READ_TOKEN` configured before these
routes are enabled. It must be a randomly generated secret of at least 32 bytes
(43 base64url characters or longer). Keep it in the production secret store;
never put its value in source control, a prompt, a browser bundle, or ordinary
chat. Give the matching value to the Capacity Planner owner through an approved
secret-sharing channel, and store it in that app's backend secret manager.

An authorized operator can generate a fresh value locally with Node.js:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Do not set a live Convex environment variable from a developer laptop. Provision
the token through the approved production operations/release process. Without
the setting, these routes fail closed with HTTP 503.

## Endpoints

Base URL: the TA Convex HTTP endpoint. Production currently uses
`https://api.career141.com`; test against a non-production deployment first.

All requests require:

```http
Authorization: Bearer <CAPACITY_PLANNER_READ_TOKEN>
```

List application tables:

```http
GET /integrations/v1/tables
```

Read a table page (default 50 rows; maximum 100):

```http
GET /integrations/v1/tables/candidates?limit=50
GET /integrations/v1/tables/candidates?limit=50&cursor=<URL-encoded-continueCursor>
```

The response contains `page`, `isDone`, and `continueCursor`. Cursors are opaque;
pass them back unchanged. Read pages sequentially and do not treat Convex IDs as
database credentials.

Download a CV by its `cvUploads` row ID:

```http
GET /integrations/v1/cv/<cvUploadId>
```

The TA backend resolves either Convex file storage or R2 and streams the file
only after validating the integration token. The CV response is an attachment
with `Cache-Control: no-store`. To make a ZIP in the Capacity Planner, its
backend can download each authorized CV and create the archive there.

## Data and safety

The table registry is checked against `convex/schema.ts` by the test suite. New
schema tables are not exposed until this registry is updated and reviewed.
Credential-like fields (including access/refresh tokens, OAuth state, and
mailbox continuation links) are redacted. This protects service credentials;
candidate and recruiting records remain readable as authorized by the owner.

These are read operations only. There is no upload, create, update, or delete
endpoint. The API does not enable browser CORS; call it from the Capacity
Planner backend, not its browser. Maintain HTTPS, keep the token server-side,
rotate/revoke it through operations, and restrict/monitor traffic at the
deployment edge before production use.

## Handoff prompt

Use this after the endpoint is deployed and the credential has been placed in
the Capacity Planner's secret manager. Replace placeholders with the approved
base URL and secret-manager variable name; never paste the secret itself into
the prompt.

> Connect the Capacity Planner backend to the Career141 TA read-only API at
> `<TA_API_BASE_URL>`. Read the bearer token from the server-side secret
> `<SECRET_MANAGER_KEY>` and send it as `Authorization: Bearer ...`. Use
> `GET /integrations/v1/tables` to discover the available application tables,
> then read records with `GET /integrations/v1/tables/{table}?limit=50` and
> continue with the returned opaque cursor. Download a CV only by its
> `cvUploads` record ID through `GET /integrations/v1/cv/{uploadId}`. Keep all
> calls server-side; never put the token in browser code or logs. This API is
> read-only: do not attempt writes, use a database/admin credential, or work
> around redacted credential fields. Handle 401/503 responses without retries
> that expose the token, and do not persist CV data longer than the agreed
> operational need.
