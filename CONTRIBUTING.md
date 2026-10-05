# Contributing

Thanks for helping improve Canvas MCP.

## Development

Use Node.js 20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run build
```

Please keep changes focused and include tests for behavior that can be tested without a real Canvas account.

## Canvas API changes

When adding a dedicated tool:

1. Prefer Canvas's documented REST endpoint and documented parameter names.
2. Keep the low level `canvas_api` escape hatch working for endpoints that do not have a dedicated tool.
3. Preserve Canvas pagination through the `Link` header.
4. Never forward the Canvas bearer token to a different origin.
5. Think through behavior in `read_only`, `student`, `teacher`, and `full` modes.

## Teacher privacy

Any tool intended for teacher mode must preserve the student pseudonymization boundary.

Do not return raw student Canvas user IDs, names, email addresses, login IDs, SIS IDs, or avatar URLs from a teacher privacy tool.

Teacher actions that target an individual student should accept a `student_ref` and resolve it on the server.

## Tests

Tests must use fictional data. Never commit real Canvas tokens, student data, assignment submissions, or school records.

## Pull requests

Describe what changed, which write modes are affected, and how you verified the change.
