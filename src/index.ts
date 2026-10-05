#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server";
import { runTerminalSetup, runWebSetup } from "./setup";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "setup") {
    if (args.includes("--web")) await runWebSetup();
    else await runTerminalSetup();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`canvas-mcp\n\nUsage:\n  canvas-mcp              Start the MCP server over stdio\n  canvas-mcp setup        Configure Canvas in the terminal\n  canvas-mcp setup --web  Configure Canvas in a local browser UI\n`);
    return;
  }

  const handle = serveStdio(() => createServer());
  process.on("SIGINT", () => void handle.close());
  process.on("SIGTERM", () => void handle.close());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
