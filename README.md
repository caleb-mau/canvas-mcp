# canvas-mcp

A self hosted MCP server for Canvas LMS.

Connect ChatGPT, Claude, or another MCP client to your own Canvas account. Read courses, assignments, grades, modules, files, discussions, announcements, Inbox messages, and more. Submit work when you explicitly choose to.

No Canvas OAuth is required for the normal self hosted setup. You create a personal Canvas access token, keep it on your own machine or deployment, and give your MCP client a separate token for access to the MCP server.

## The important safety rule

**Drafting is not submitting.**

If you ask an AI to read an assignment, solve it, draft a response, rewrite it, review it, or finish the writing, Canvas MCP does not submit anything.

Submission tools are only intended to be called after you explicitly ask to **submit** or **turn in** the work. Even then, the server asks the end user for confirmation before changing Canvas.

The same confirmation protection applies by default to grading, Canvas Inbox messages, discussion posts, and raw mutating Canvas API calls.

If the connected MCP client cannot complete the confirmation request, the protected write does not continue.

You can disable this advanced safety default with:

```
CANVAS_REQUIRE_CONFIRMATION=false
```

## Fastest setup: Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcaleb-mau%2Fcanvas-mcp&env=CANVAS_BASE_URL%2CCANVAS_ACCESS_TOKEN%2CMCP_AUTH_TOKEN%2CCANVAS_WRITE_MODE)

Set these values in the deployment:

| Variable | What it is |
| --- | --- |
| `CANVAS_BASE_URL` | Your Canvas domain, such as `https://school.instructure.com` |
| `CANVAS_ACCESS_TOKEN` | Personal token created inside Canvas |
| `MCP_AUTH_TOKEN` | A separate random secret used by your MCP client |
| `CANVAS_WRITE_MODE` | Usually `student`, `teacher`, `read_only`, or `full` |

After deployment, your MCP endpoint is:

```
https://your-deployment.example/mcp
```

### ChatGPT

ChatGPT currently expects OAuth for authenticated custom MCP connections.

Canvas MCP includes a small built in OAuth 2.1 compatibility layer, so you do not need Auth0, Clerk, a database, or a separate OAuth provider.

In ChatGPT:

1. Add your deployed MCP URL, for example `https://your-deployment.example/mcp`
2. Choose OAuth authentication
3. ChatGPT discovers the OAuth endpoints automatically
4. A Canvas MCP authorization page opens
5. Enter the same `MCP_AUTH_TOKEN` you configured in Vercel
6. Approve the connection

There is no OAuth client ID or client secret for you to configure. ChatGPT identifies itself using its own Client ID Metadata Document and uses PKCE.

If ChatGPT shows **OAuth advanced settings**, the expected values are:

* Registration method: `Client Identifier Metadata Document (CIMD)`
* Callback URL: `https://chatgpt.com/connector_platform_oauth_redirect`
* CIMD client metadata URL: `https://chatgpt.com/oauth/client.json`
* Default scopes: `mcp` and `offline_access`
* Base scopes: leave empty
* Auth URL: `https://YOUR_DEPLOYMENT/oauth/authorize`
* Token URL: `https://YOUR_DEPLOYMENT/oauth/token`
* Registration URL: leave empty
* Authorization server base: your deployment origin
* Resource: your deployment origin
* OIDC: disabled

The DCR warning is expected because this project intentionally uses CIMD and does not expose Dynamic Client Registration.

Canvas authentication is unchanged. The server still uses `CANVAS_ACCESS_TOKEN` privately to talk to Canvas.

### Other MCP clients

Clients that support a normal bearer token can skip the OAuth browser flow and authenticate directly with:

```
Authorization: Bearer YOUR_MCP_AUTH_TOKEN
```

The OAuth layer and the direct bearer path protect the same self hosted MCP instance.

That is it. The Canvas token stays on the server. The MCP caller never receives the Canvas token.

## Get a Canvas access token

Inside Canvas:

1. Open **Account**
2. Open **Settings**
3. Find **Approved Integrations**
4. Choose **New Access Token**
5. Create a token and copy it

Use your normal Canvas origin as `CANVAS_BASE_URL`.

Good:

```
https://school.instructure.com
```

Do not use:

```
https://school.instructure.com/profile/settings
```

Treat the Canvas token like a password.

## Run locally instead

Requirements:

* Node.js 20 or newer
* npm

```bash
git clone https://github.com/caleb-mau/canvas-mcp.git
cd canvas-mcp
npm install
npm run setup
```

Optional local browser setup:

```bash
npm run setup:web
```

Example local MCP configuration:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "npm",
      "args": ["run", "start:stdio", "--silent"],
      "cwd": "/absolute/path/to/canvas-mcp"
    }
  }
}
```

## What it can do

Dedicated tools cover common Canvas work:

* Courses
* Assignments and assignment instructions
* Grades and recently graded work
* Submission history
* Text submissions
* URL submissions
* File uploads and submissions
* Modules and module completion
* Pages
* Discussions and replies
* Course files and downloads
* Announcements
* Calendar events
* Planner items
* Activity stream
* Canvas Inbox
* Classic quizzes
* Teacher rosters, submissions, grading, and messaging

There is also a low level `canvas_api` tool for Canvas REST endpoints that do not have a dedicated tool.

GET requests are read only. Raw mutating calls require confirmation by default and still obey the configured write mode.

## Write modes

### `read_only`

Reads Canvas. Blocks writes.

### `student`

The normal student mode. Allows student actions such as submissions, discussion posts, and Canvas Inbox messages.

Teacher and administrator mutations are blocked.

### `teacher`

Allows course level teacher actions while automatically pseudonymizing known student identities before results reach the model.

Instead of a real student identity, the model sees a stable reference such as:

```
student_R7K4Q2M8PZ
```

When the model grades or messages that student, the server resolves the alias to the real Canvas user internally.

Known names, emails, login IDs, SIS IDs, avatar URLs, and raw Canvas user IDs are removed or replaced before teacher mode results are returned.

No alias database is required. Aliases are derived with HMAC from the server side redaction key. Course data uses course scoped aliases. Teacher responses outside a specific course use context scoped aliases rather than a universal student identifier.

The teacher roster also follows a minimum necessary default: grades and activity history are omitted unless `include_academic_context` is explicitly requested.

Teacher mode is identity protection, not a general data loss prevention system. Free form student content can still contain personal information that Canvas does not identify separately.

### `full`

Allows arbitrary same origin Canvas REST mutations permitted by the configured Canvas token.

Use this only when you intentionally want the full Canvas permission surface.

## FERPA conscious workflows

Canvas MCP is designed to make privacy preserving workflows easier without requiring a student database.

Teacher mode pseudonymizes known student identities, keeps mappings stateless, minimizes roster data by default, avoids application payload logging, and instructs remote clients and caches not to store MCP responses.

This is deliberately described as **FERPA conscious**, not automatically **FERPA compliant**. Whether a real deployment satisfies FERPA depends on the school, the user's legitimate educational interest, district approval, the AI provider, hosting, retention terms, and how records are used.

Pseudonymized student references are not represented as legally de identified records.

See [PRIVACY.md](PRIVACY.md) for the full privacy design and no database architecture.

## Confirmation behavior

By default:

```
CANVAS_REQUIRE_CONFIRMATION=true
```

Confirmation protected actions include:

* Assignment text submissions
* Assignment URL submissions
* Assignment file uploads and submissions
* Discussion posts and replies
* Canvas Inbox messages
* Teacher grade changes and comments
* Teacher messages
* Any non GET request through `canvas_api`

For file submissions, confirmation occurs **before the upload starts**.

Small local state actions such as marking a module item complete are not currently confirmation gated.

## File submissions

`canvas_submit_file` supports two file sources:

* **Hosted MCP clients:** pass a real MCP file object in `file`
* **Local stdio clients:** pass a filesystem path in `file_path`

For ChatGPT, the tool declares `_meta["openai/fileParams"] = ["file"]`. ChatGPT can therefore hand the tool an authorized file reference instead of asking the user or model to paste a download URL.

The file reference has this shape:

```json
{
  "download_url": "https://temporary-file-url.example/...",
  "file_id": "file_...",
  "mime_type": "application/pdf",
  "file_name": "essay.pdf"
}
```

This is source agnostic. The file can come from Google Drive, another compatible connector, a user upload, a generated file, or any other client that can provide the same file reference. Canvas MCP does not contain Google Drive specific code.

For a hosted file reference, the flow is:

1. The MCP client supplies the temporary file reference
2. The user confirms the Canvas submission
3. Canvas MCP securely downloads the file bytes
4. Canvas MCP asks Canvas for an upload target
5. Canvas MCP uploads the bytes to that target
6. Canvas completes the upload and returns a Canvas file ID
7. Canvas MCP submits that Canvas file ID to the assignment

For a local `file_path`, the same Canvas upload flow starts from the local file bytes instead.

Remote file downloads must use HTTPS. Canvas MCP rejects localhost and private network targets, validates redirect targets, does not forward Canvas credentials to the file source, and enforces a configurable download size limit.

The default remote file limit is 50 MB and can be changed with:

```
CANVAS_MAX_REMOTE_FILE_MB=50
```

Confirmation happens before the remote file is downloaded, so cancelling the submission does not fetch or upload the file.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CANVAS_BASE_URL` | required | Canvas origin |
| `CANVAS_ACCESS_TOKEN` | required | Personal Canvas access token |
| `MCP_AUTH_TOKEN` | required for remote mode | Protects the remote MCP endpoint and acts as the single user secret for the built in OAuth flow |
| `CANVAS_WRITE_MODE` | `student` | Permission boundary |
| `CANVAS_REQUIRE_CONFIRMATION` | `true` | Requires end user confirmation for protected writes |
| `CANVAS_MAX_PAGES` | `20` | Maximum Canvas pagination pages followed per call |
| `CANVAS_TIMEOUT_MS` | `30000` | Canvas request timeout |
| `CANVAS_MAX_REMOTE_FILE_MB` | `50` | Maximum downloaded MCP file size before Canvas upload |
| `CANVAS_REDACTION_KEY` | automatic fallback | Stable teacher mode aliases |

## How the built in OAuth works

The OAuth layer exists for MCP clients such as ChatGPT that require OAuth discovery and an authorization code flow.

It publishes:

* Protected resource metadata
* OAuth authorization server metadata
* Authorization code flow
* PKCE with S256
* Short lived access tokens
* Refresh tokens
* The `resource` audience binding required by MCP authorization

It is intentionally single user. The authorization page verifies `MCP_AUTH_TOKEN`, then the server issues signed OAuth tokens for that deployment.

There is still no account database and no Canvas OAuth.

Rotating `MCP_AUTH_TOKEN` immediately invalidates OAuth tokens signed with the old secret.

## Security

Never commit or post:

* Canvas access tokens
* MCP authentication tokens
* Redaction keys
* Local config files
* Real student records

If a Canvas token is exposed, revoke it in Canvas and create another one.

If `MCP_AUTH_TOKEN` is exposed, rotate it on the deployment.

See [SECURITY.md](SECURITY.md) for more.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
