import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WriteMode = "read_only" | "student" | "full";

export interface CanvasMcpConfig {
  baseUrl: string;
  accessToken: string;
  writeMode: WriteMode;
  maxPages: number;
  timeoutMs: number;
}

export interface StoredConfig {
  baseUrl?: string;
  accessToken?: string;
  writeMode?: WriteMode;
  maxPages?: number;
  timeoutMs?: number;
}

export function configPath(): string {
  if (process.env.CANVAS_MCP_CONFIG?.trim()) {
    return process.env.CANVAS_MCP_CONFIG.trim();
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), ".config");
  return join(base, "canvas-mcp", "config.json");
}

export function normalizeBaseUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error("Canvas base URL is required.");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("Canvas base URL must use HTTPS.");
  }

  url.hash = "";
  url.search = "";
  url.pathname = "";

  return url.toString().replace(/\/$/, "");
}

function parseNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return Math.floor(parsed);
}

function parseWriteMode(value: string | undefined): WriteMode | undefined {
  if (!value) return undefined;
  if (value === "read_only" || value === "student" || value === "full") return value;
  throw new Error("CANVAS_WRITE_MODE must be read_only, student, or full.");
}

export async function readStoredConfig(): Promise<StoredConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as StoredConfig;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }
}

export async function loadConfig(): Promise<CanvasMcpConfig> {
  const stored = await readStoredConfig();
  const baseUrl = process.env.CANVAS_BASE_URL?.trim() || stored.baseUrl?.trim();
  const accessToken = process.env.CANVAS_ACCESS_TOKEN?.trim() || stored.accessToken?.trim();

  if (!baseUrl || !accessToken) {
    throw new Error(
      `Canvas MCP is not configured. Run "canvas-mcp setup" or set CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN. Config path: ${configPath()}`,
    );
  }

  const writeMode =
    parseWriteMode(process.env.CANVAS_WRITE_MODE) || stored.writeMode || "student";

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    accessToken,
    writeMode,
    maxPages: parseNumber(
      process.env.CANVAS_MAX_PAGES,
      stored.maxPages ?? 20,
      1,
      200,
    ),
    timeoutMs: parseNumber(
      process.env.CANVAS_TIMEOUT_MS,
      stored.timeoutMs ?? 30_000,
      1_000,
      300_000,
    ),
  };
}

export async function saveConfig(config: StoredConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const clean: StoredConfig = {
    baseUrl: config.baseUrl ? normalizeBaseUrl(config.baseUrl) : undefined,
    accessToken: config.accessToken?.trim(),
    writeMode: config.writeMode || "student",
    maxPages: config.maxPages ?? 20,
    timeoutMs: config.timeoutMs ?? 30_000,
  };
  await writeFile(path, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export function redactedConfig(config: CanvasMcpConfig) {
  return {
    baseUrl: config.baseUrl,
    accessToken: config.accessToken.length > 8 ? `${config.accessToken.slice(0, 4)}…${config.accessToken.slice(-4)}` : "configured",
    writeMode: config.writeMode,
    maxPages: config.maxPages,
    timeoutMs: config.timeoutMs,
    configPath: configPath(),
  };
}
