# canvas-mcp

A self hosted Model Context Protocol server for Canvas LMS.

Canvas MCP connects an MCP client directly to your own Canvas account. It can run locally over stdio or remotely over Streamable HTTP on Vercel or another Next.js host.

There is no Canvas OAuth flow, no hosted account system, and no shared database. You create a personal access token inside Canvas, configure your own instance, and your MCP client can use whatever Canvas permissions that token already has.

## What it can do

First class tools are included for:

* Courses
* Assignments and assignment descriptions
* Grades and recently graded work
* Current and historical submissions
* Text submissions
* URL submissions
* File uploads and file submissions
* Modules and module completion state
* Course pages
* Discussions and replies
* Course files and local file downloads
* Announcements
* Calendar events
* Planner items
* Activity stream
* Canvas Inbox conversations
* Classic quizzes

The `canvas_api` tool is also a low level escape hatch for any same origin Canvas REST endpoint under `/api/...`. That means uncommon district features and Canvas endpoints do not need to be individually wrapped before an MCP client can use them.

Canvas permissions are still the final authority. The MCP cannot do anything the configured Canvas account is not allowed to do.

## Get your Canvas access token

In Canvas:

1. Open **Account**
2. Open **Settings**
3. Find **Approved Integrations**
4. Choose **New Access Token**
5. Create a token and copy it

Your Canvas base URL is the normal domain you use to access Canvas, for example:

```
https://school.instructure.com
```

Do not include `/profile/settings` or another page path.

Treat the Canvas access token like a password.

## Option 1: Deploy to Vercel

This is the easiest remote setup.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcaleb-mau%2Fcanvas-mcp&env=CANVAS_BASE_URL%2CCANVAS_ACCESS_TOKEN%2CMCP_AUTH_TOKEN%2CCANVAS_WRITE_MODE)

Set these environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CANVAS_BASE_URL` | yes | Your Canvas origin |
| `CANVAS_ACCESS_TOKEN` | yes | Personal token created in Canvas settings |
| `MCP_AUTH_TOKEN` | yes for remote mode | Secret used by your MCP client to authenticate to this server |
| `CANVAS_WRITE_MODE` | no | `read_only`, `student`, or `full`. Default is `student` |
| `CANVAS_MAX_PAGES` | no | Maximum Canvas pagination pages followed per tool call. Default is 20 |
| `CANVAS_TIMEOUT_MS` | no | Canvas request timeout. Default is 30000 |

Generate `MCP_AUTH_TOKEN` as a long random secret. It is not your Canvas token.

After deployment, the remote MCP endpoint is:

```
https://your-deployment.example/mcp
```

Remote clients authenticate with:

```
Authorization: Bearer YOUR_MCP_AUTH_TOKEN
```

The Canvas access token remains stored on the deployment and is never sent to the MCP caller.

The remote endpoint is stateless. It does not need Redis, sticky sessions, or a database.

## Option 2: Run locally over stdio

Requirements:

* Node.js 20 or newer
* npm
* An MCP client that can launch a local process

Install:

```bash
git clone https://github.com/caleb-mau/canvas-mcp.git
cd canvas-mcp
npm install
npm run build
npm run setup
```

For a local browser configuration screen:

```bash
npm run setup:web
```

Then configure your MCP client to launch:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["/absolute/path/to/canvas-mcp/dist-cli/src/index.js"]
    }
  }
}
```

During development:

```bash
npm run dev:stdio
```

## Local configuration

The terminal and browser setup commands save a local config file, normally:

```
~/.config/canvas-mcp/config.json
```

Environment variables override values in that file.

The browser setup page binds only to `127.0.0.1` and tests the Canvas connection before saving.

## Write modes

### `read_only`

Blocks all Canvas mutations.

### `student`

Default mode. Allows normal student actions such as:

* Submit assignments
* Upload submission files
* Post discussion entries and replies
* Send Canvas Inbox messages
* Mark supported module state

The low level `canvas_api` tool is prevented from making arbitrary teacher or administrator mutations in this mode.

### `full`

Allows the low level API tool to make any same origin Canvas REST request supported by the configured token.

Use this only when you intentionally want the full permission surface of the Canvas account.

## File submissions

Canvas file submissions are not a normal single POST request. Canvas MCP implements the complete Canvas upload flow:

1. Request an upload URL and parameters from Canvas
2. Upload the file to the returned storage target
3. Complete the upload with Canvas
4. Submit the returned Canvas file ID to the assignment

The Canvas token is only sent to the configured Canvas origin. It is not forwarded to external file storage hosts.

## Raw Canvas API tool

`canvas_api` accepts:

* HTTP method
* Canvas API path
* Query parameters
* Form or JSON body
* Optional automatic pagination

Example conceptual call:

```json
{
  "method": "GET",
  "path": "/api/v1/courses/123/assignment_groups",
  "paginate": true
}
```

Absolute URLs are accepted only when they match the configured Canvas origin. Cross origin credential forwarding is rejected.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The project uses:

* TypeScript
* MCP TypeScript SDK v2
* Zod
* Next.js for the optional remote HTTP deployment
* Node stdio for local MCP clients

## Security

Never commit:

* Canvas access tokens
* MCP authentication tokens
* Local config files
* `.env` files

For a remote deployment, use your hosting provider's encrypted environment variables.

If a token is exposed, revoke or rotate it immediately.

## License

MIT
