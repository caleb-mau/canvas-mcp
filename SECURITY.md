# Security Policy

## Secrets

Never include any of the following in a public issue, pull request, log, screenshot, or reproduction:

* Canvas personal access tokens
* `MCP_AUTH_TOKEN`
* `CANVAS_REDACTION_KEY`
* Student names, emails, login IDs, SIS IDs, submissions, grades, or other private education records
* A local Canvas MCP config file containing credentials

If a Canvas token is exposed, revoke it in Canvas immediately and create a replacement.

If an MCP bearer token is exposed, rotate `MCP_AUTH_TOKEN` on the deployment before continuing to use the server.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting when it is available for this repository. Do not open a public issue containing an exploitable vulnerability or real credentials.

A useful report should include:

* The affected commit or version
* Whether the server was running locally or remotely
* The configured write mode
* Reproduction steps using fake data
* The security impact
* A proposed mitigation, if known

## Teacher privacy mode

Teacher mode is designed to pseudonymize known Canvas student identity fields before responses reach an MCP model.

Pseudonymous `student_ref` values are not claimed to make a record legally de identified under FERPA. Course aliases are deliberately scoped to reduce unnecessary correlation, and no alias mapping database is stored.

It is not a general purpose data loss prevention system. Free form content can contain personal information that Canvas does not separately identify, such as a phone number or home address typed by a student. Do not assume teacher mode can detect arbitrary unknown personal data.

## Module video downloads

Video retrieval is opt in and is never performed during normal module reads.

Short lived video links are HMAC signed and expire after ten minutes. The requested source URL, output limit, and quality bound are covered by the signature, so callers cannot modify them after the MCP tool creates the link.

Before serving media, canvas-mcp requires HTTPS and rejects localhost and private network addresses. Direct MP4 redirects are revalidated. yt-dlp runs without Canvas credentials, cookies, or user supplied command line arguments.

The automatically bootstrapped Vercel binary is pinned to a specific upstream yt-dlp release and verified with its published SHA 256 digest before execution.

Do not add arbitrary yt-dlp flags from model or user input. Keep the allowed argument surface fixed in server code.

## Remote file references

Hosted file submission accepts temporary MCP file download URLs. To reduce server side request forgery risk, Canvas MCP:

* Requires HTTPS
* Rejects localhost
* Rejects private and local network IP ranges
* Resolves hostnames and rejects private resolution results
* Revalidates redirect targets
* Limits redirects
* Enforces a configurable maximum download size
* Never sends the Canvas bearer token to the file source

Do not weaken these checks merely to support a storage provider. File integrations should produce ordinary HTTPS file references instead.

## Education record handling

The application does not intentionally log Canvas response bodies, student submissions, grades, messages, or roster payloads. Hosted MCP responses are marked `Cache-Control: no-store`.

Infrastructure providers and MCP or AI clients can have independent logging and retention behavior. Those systems must be evaluated separately for real education record use.

See [PRIVACY.md](PRIVACY.md).

## Supported versions

Until the project reaches a stable tagged release, security fixes are made against the current `main` branch.
