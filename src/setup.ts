import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CanvasClient } from "./canvas";
import { normalizeBaseUrl, readStoredConfig, saveConfig, type StoredConfig, type WriteMode } from "./config";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

async function testCredentials(config: StoredConfig): Promise<unknown> {
  if (!config.baseUrl || !config.accessToken) throw new Error("Base URL and access token are required.");
  const client = new CanvasClient({
    baseUrl: normalizeBaseUrl(config.baseUrl),
    accessToken: config.accessToken.trim(),
    writeMode: config.writeMode || "student",
    maxPages: config.maxPages || 20,
    timeoutMs: config.timeoutMs || 30_000,
  });
  return (await client.get("/api/v1/users/self/profile")).data;
}

export async function runTerminalSetup(): Promise<void> {
  const existing = await readStoredConfig();
  const rl = createInterface({ input, output });
  try {
    const baseUrl = await rl.question(`Canvas base URL${existing.baseUrl ? ` [${existing.baseUrl}]` : ""}: `);
    const accessToken = await rl.question(`Canvas access token${existing.accessToken ? " [leave blank to keep current token]" : ""}: `);
    const modeAnswer = await rl.question(`Write mode, read_only, student, teacher, or full [${existing.writeMode || "student"}]: `);
    const writeMode = (modeAnswer.trim() || existing.writeMode || "student") as WriteMode;
    if (!["read_only", "student", "teacher", "full"].includes(writeMode)) throw new Error("Invalid write mode.");

    const config: StoredConfig = {
      baseUrl: baseUrl.trim() || existing.baseUrl,
      accessToken: accessToken.trim() || existing.accessToken,
      writeMode,
      maxPages: existing.maxPages || 20,
      timeoutMs: existing.timeoutMs || 30_000,
    };

    output.write("Testing Canvas connection...\n");
    const profile = await testCredentials(config) as Record<string, unknown>;
    const path = await saveConfig(config);
    output.write(`Connected as ${String(profile.name || profile.short_name || profile.id || "Canvas user")}.\nSaved configuration to ${path}\n`);
  } finally {
    rl.close();
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function runWebSetup(): Promise<void> {
  const existing = await readStoredConfig();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'");

    if (req.method === "POST" && url.pathname === "/save") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) {
          res.writeHead(413).end("Too large");
          return;
        }
      }
      try {
        const form = new URLSearchParams(body);
        const config: StoredConfig = {
          baseUrl: form.get("baseUrl") || undefined,
          accessToken: form.get("accessToken") || existing.accessToken || undefined,
          writeMode: (form.get("writeMode") || "student") as WriteMode,
          maxPages: Number(form.get("maxPages") || 20),
          timeoutMs: Number(form.get("timeoutMs") || 30_000),
        };
        const profile = await testCredentials(config) as Record<string, unknown>;
        const path = await saveConfig(config);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Canvas MCP configured</title><style>body{font-family:system-ui;max-width:760px;margin:60px auto;padding:0 24px;line-height:1.5}code{background:#eee;padding:2px 5px;border-radius:4px}</style><h1>Canvas MCP is ready</h1><p>Connected as <strong>${escapeHtml(String(profile.name || profile.short_name || profile.id || "Canvas user"))}</strong>.</p><p>Configuration saved locally to <code>${escapeHtml(path)}</code>.</p><p>You can close this tab and start your MCP client.</p>`);
        setTimeout(() => server.close(), 250);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Could not save configuration</h1><pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre><p><a href="/">Go back</a></p>`);
      }
      return;
    }

    if (req.method !== "GET" || url.pathname !== "/") {
      res.writeHead(404).end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas MCP setup</title>
<style>body{font-family:system-ui;background:#f5f5f5;color:#171717;margin:0}.card{max-width:720px;margin:56px auto;background:white;border:1px solid #ddd;border-radius:16px;padding:30px;box-shadow:0 8px 30px #0000000d}label{display:block;font-weight:650;margin:18px 0 7px}input,select{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #bbb;border-radius:8px;font:inherit}button{margin-top:24px;padding:11px 16px;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:700;cursor:pointer}.muted{color:#666;font-size:.94rem}code{background:#eee;padding:2px 5px;border-radius:4px}</style></head>
<body><main class="card"><h1>Canvas MCP setup</h1><p>This page runs only on <code>127.0.0.1</code>. Your token is saved to your local Canvas MCP config file and is not sent anywhere except your configured Canvas instance.</p>
<form method="post" action="/save">
<label for="baseUrl">Canvas base URL</label><input id="baseUrl" name="baseUrl" required placeholder="https://school.instructure.com" value="${escapeHtml(existing.baseUrl || "")}">
<label for="accessToken">Canvas personal access token</label><input id="accessToken" name="accessToken" type="password" ${existing.accessToken ? "" : "required"} placeholder="${existing.accessToken ? "Leave blank to keep the saved token" : "Paste token from Canvas Account Settings"}">
<label for="writeMode">Write mode</label><select id="writeMode" name="writeMode"><option value="read_only" ${existing.writeMode === "read_only" ? "selected" : ""}>read_only</option><option value="student" ${!existing.writeMode || existing.writeMode === "student" ? "selected" : ""}>student</option><option value="teacher" ${existing.writeMode === "teacher" ? "selected" : ""}>teacher</option><option value="full" ${existing.writeMode === "full" ? "selected" : ""}>full</option></select>
<p class="muted"><strong>student</strong> allows normal student actions such as submitting work, posting discussions, and messaging. <strong>teacher</strong> enables course management and grading while pseudonymizing student identities before responses reach the model. <strong>full</strong> also enables unrestricted mutating calls through the low level Canvas API tool.</p>
<label for="maxPages">Maximum pages per paginated tool call</label><input id="maxPages" name="maxPages" type="number" min="1" max="200" value="${existing.maxPages || 20}">
<label for="timeoutMs">Request timeout in milliseconds</label><input id="timeoutMs" name="timeoutMs" type="number" min="1000" max="300000" value="${existing.timeoutMs || 30000}">
<button type="submit">Test connection and save</button></form></main></body></html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start local setup server.");
  const url = `http://127.0.0.1:${address.port}/`;
  process.stderr.write(`Canvas MCP setup: ${url}\n`);
  openBrowser(url);
}
