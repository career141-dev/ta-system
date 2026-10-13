# Capacity Planner Integration API

The Capacity Planner connects to the TA system through this API. It does not
receive a Convex admin key, database credential, or R2 bucket credential. The
API responds only to authenticated server-to-server requests. Table access is
read-only; the only write operation is the explicit new-CV intake flow below.

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

Upload a new CV into the same R2 bucket and queue it through the TA ingestion
pipeline (maximum 10 MB; PDF, DOC, or DOCX only):

1. Compute the file's SHA-256 digest and encode the 32 digest bytes as standard
   base64. Request a short-lived upload URL:

   ```http
   POST /integrations/v1/cv/uploads
   Authorization: Bearer <CAPACITY_PLANNER_READ_TOKEN>
   Content-Type: application/json

   {"fileName":"candidate.pdf","contentType":"application/pdf","fileSize":12345,"checksumSha256":"<base64-sha256>"}
   ```

2. PUT the raw file bytes to the returned `url`, including the returned
   `requiredHeaders` exactly. The URL expires in five minutes and is bound to
   the declared content type, file size, and checksum.

3. Confirm the stored object:

   ```http
   POST /integrations/v1/cv/uploads/complete
   Authorization: Bearer <CAPACITY_PLANNER_READ_TOKEN>
   Content-Type: application/json

   {"key":"<returned-key>","fileName":"candidate.pdf","fileType":"application/pdf","fileSize":12345,"checksumSha256":"<base64-sha256>"}
   ```

   TA verifies the R2 object and checksum, stores file metadata in the
   `partnerCvFiles` registry, and returns its `fileId`. The file is not parsed,
   matched to a candidate, or added to the TA CV intake pipeline. Retrieve it
   later with `GET /integrations/v1/cv/<fileId>`. Repeating completion for the
   same key returns the same file ID.

   ```json
   {"uploaded":true,"file":{"fileId":"<id>","stored":true,"processed":false}}
   ```

This endpoint stores files for partner use only. It does not create candidates,
replace a candidate's CV, or run extraction/duplicate matching.

## Data and safety

The table registry is checked against `convex/schema.ts` by the test suite. New
schema tables are not exposed until this registry is updated and reviewed.
Credential-like fields (including access/refresh tokens, OAuth state, and
mailbox continuation links) are redacted. This protects service credentials;
candidate and recruiting records remain readable as authorized by the owner.

There are no general create, update, or delete endpoints. CV intake is limited
to the presigned upload flow above; table records cannot be changed. The API
does not enable browser CORS; call it from the Capacity Planner backend, not
its browser. Maintain HTTPS, keep the token server-side, rotate/revoke it
through operations, and restrict/monitor traffic at the deployment edge before
production use.

## Handoff prompt

Use this after the endpoint is deployed and the credential has been placed in
the Capacity Planner's secret manager. Replace placeholders with the approved
base URL and secret-manager variable name; never paste the secret itself into
the prompt.

> Connect the Capacity Planner backend to the Career141 TA integration API at
> `<TA_API_BASE_URL>`. Read the bearer token from the server-side secret
> `<SECRET_MANAGER_KEY>` and send it as `Authorization: Bearer ...`. Use
> `GET /integrations/v1/tables` to discover the available application tables,
> then read records with `GET /integrations/v1/tables/{table}?limit=50` and
> continue with the returned opaque cursor. Download a CV only by its
> `cvUploads` record ID through `GET /integrations/v1/cv/{uploadId}`. Keep all
> calls server-side; never put the token in browser code or logs. Table access
> is read-only. For a new CV, compute its SHA-256 digest, request
> `POST /integrations/v1/cv/uploads` with filename, supported MIME type, exact
> byte length and base64 SHA-256, PUT the bytes to the returned short-lived URL
> with the returned headers, then call
> `POST /integrations/v1/cv/uploads/complete` with the returned key and same
> metadata. The response contains a file ID; retrieve it later through
> `GET /integrations/v1/cv/{fileId}`. This stores the file only and does not
> parse it or change candidate records. Do not use a database/admin credential or
> work around redacted credential fields. Handle 401/503 responses without retries
> that expose the token, and do not persist CV data longer than the agreed
> operational need.
