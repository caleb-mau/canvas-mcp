# Privacy Design

Canvas MCP is designed to support **FERPA conscious workflows**.

That phrase is intentional. This project does not claim that deploying or using it automatically makes a school, teacher, AI provider, or workflow FERPA compliant. FERPA obligations depend on the institution, the user's authority to access records, the service receiving the information, contracts and policies, and how the data is ultimately used.

## No database required

Canvas MCP does not require a student database, identity mapping table, or persistent session store.

The application does not persist:

* Student rosters
* Student names
* Grades
* Assignment submissions
* Discussion content
* Canvas messages
* Student alias mappings
* OAuth sessions

Canvas remains the source of truth.

For teacher privacy mode, student aliases are generated deterministically with HMAC from:

* The private redaction key
* The Canvas origin
* The course ID
* The Canvas user ID

This means the same student gets the same pseudonymous reference inside the same course without storing a mapping anywhere.

When an action needs the real student identity, the server fetches the current Canvas roster, recomputes aliases, resolves the matching user locally, performs the Canvas action, and discards the roster when the request process ends.

## Course scoped pseudonyms

Teacher mode uses course scoped aliases such as:

```
student_R7K4Q2M8PZ
```

The model does not need the student's Canvas ID or name to grade, comment on, or message that student.

Course scoped aliases intentionally reduce unnecessary correlation across classes.

These references are **pseudonymous**, not guaranteed to be legally de identified data.

## Data minimization

Teacher tools are designed to request and expose the minimum useful information for the task.

For example, the teacher roster tool returns only:

* `student_ref`
* Enrollment state
* Course section

Grades and activity information are omitted by default and must be explicitly requested with `include_academic_context`.

Submission tools expose assignment content only when the workflow actually needs the submission.

## Known identity redaction

Teacher mode attempts to remove or replace known Canvas identity fields before results leave the server, including:

* Student names
* Canvas user IDs
* Email addresses
* Login IDs
* SIS IDs
* Avatar URLs

It also replaces recognized roster identifiers when they appear in returned strings.

This is not a general purpose data loss prevention system. A student can type identifying information into free form content that Canvas does not label as identity data.

Examples include:

* A phone number
* A home address
* A personal social account
* A family member's name

The server cannot reliably remove information it does not know is identifying.

## No application payload logging

Canvas MCP does not intentionally log Canvas API response bodies, assignment submissions, grades, messages, or student roster payloads.

Hosting providers, reverse proxies, MCP clients, AI providers, or other infrastructure may have their own logging and retention behavior. Review those systems separately before using them with protected education records.

## No caching of remote MCP responses

The hosted `/mcp` route sends `Cache-Control: no-store` and related response headers so browsers and intermediary caches are instructed not to retain MCP responses.

## Access control

The Canvas token determines what the Canvas API permits.

Canvas MCP adds additional boundaries:

* `read_only` blocks all writes
* `student` permits ordinary student actions
* `teacher` permits course level teacher actions while enabling student pseudonymization
* `full` exposes the wider Canvas permission surface and should be used deliberately

Consequential writes are explicitly annotated so capable MCP hosts can present native end user approval before execution. Tool annotations do not replace Canvas permissions or server side authorization.

## External AI providers

Pseudonymization reduces the amount of directly identifying information sent to an MCP model, but education records can still be sensitive even when names are removed.

Before using teacher mode with real student records, schools and teachers should verify that the AI service is approved for the intended educational use and that its retention, training, access, and redisclosure terms fit their obligations and district policies.

## Practical deployment guidance

For the most privacy conscious teacher setup:

1. Use `CANVAS_WRITE_MODE=teacher`
2. Use an MCP client that honors destructive write approvals
3. Set a strong `CANVAS_REDACTION_KEY`
4. Keep the deployment private
5. Do not enable `full` unless genuinely required
6. Use only school approved AI clients and hosting
7. Avoid requesting academic context unless the task needs it
8. Rotate access tokens immediately if exposed

## Terminology

This project uses:

**Pseudonymized** when a stable alias replaces a real student identity.

**Redacted** when known identity fields are removed or replaced.

**FERPA conscious** to describe privacy preserving design choices.

It does not use **FERPA compliant** as a blanket product claim.
