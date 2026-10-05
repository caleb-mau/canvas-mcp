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
          token stays on this deployment. ChatGPT can connect through the built in
          OAuth flow, while other clients can use the same MCP secret directly.
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
            <h2>ChatGPT authentication</h2>
            <code>OAuth 2.1 + PKCE, backed by MCP_AUTH_TOKEN</code>
          </div>
        </div>

        <h2>Canvas surface</h2>
        <div className="chips">
          {tools.map((tool) => <span key={tool}>{tool}</span>)}
        </div>

        <p className="foot">
          In ChatGPT, add this deployment's /mcp URL and choose OAuth. When the
          authorization page opens, enter the MCP_AUTH_TOKEN from this deployment.
          Reading and drafting do not submit work. Consequential Canvas writes
          are marked destructive so capable MCP hosts can show their native
          approval UI before execution.
        </p>
      </section>
    </main>
  );
}
