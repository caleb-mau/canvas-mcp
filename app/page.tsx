const tools = [
  "Courses",
  "Assignments",
  "Grades",
  "Submissions",
  "Modules",
  "Pages",
  "Discussions",
  "Files",
  "Announcements",
  "Planner",
  "Calendar",
  "Inbox",
  "Quizzes",
  "Raw Canvas API",
  "Explicit write confirmation",
];

export default function Home() {
  const configured = Boolean(
    process.env.CANVAS_BASE_URL &&
    process.env.CANVAS_ACCESS_TOKEN &&
    process.env.MCP_AUTH_TOKEN
  );

  return (
    <main className="shell">
      <section className="card">
        <div className="eyebrow">Canvas MCP</div>
        <h1>Your Canvas account, available over MCP.</h1>
        <p className="lead">
          A self hosted bridge from AI clients to Canvas LMS. Your Canvas access
          token stays on this deployment. Remote MCP callers authenticate with a
          separate bearer token.
        </p>

        <div className="status">
          <span className={configured ? "dot ready" : "dot"} />
          <span>
            {configured
              ? "Required deployment secrets are configured."
              : "Deployment is running, but one or more required secrets are missing."}
          </span>
        </div>

        <div className="grid">
          <div>
            <h2>MCP endpoint</h2>
            <code>/mcp</code>
          </div>
          <div>
            <h2>Authentication</h2>
            <code>Authorization: Bearer MCP_AUTH_TOKEN</code>
          </div>
        </div>

        <h2>Canvas surface</h2>
        <div className="chips">
          {tools.map((tool) => <span key={tool}>{tool}</span>)}
        </div>

        <p className="foot">
          Reading and drafting do not submit work. Assignment submissions,
          grading, messages, discussion posts, and raw mutating API calls ask
          for end user confirmation by default. Canvas permissions still apply.
        </p>
      </section>
    </main>
  );
}
