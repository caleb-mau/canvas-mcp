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

It is not a general purpose data loss prevention system. Free form content can contain personal information that Canvas does not separately identify, such as a phone number or home address typed by a student. Do not assume teacher mode can detect arbitrary unknown personal data.

## Supported versions

Until the project reaches a stable tagged release, security fixes are made against the current `main` branch.
