import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, chmod, writeFile } from "node:fs/promises";
import { isIP } from "node:net";

const VIDEO_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_MAX_VIDEO_MB = 250;

const YTDLP_VERSION = "2026.08.19";
const YTDLP_LINUX_X64_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux";
const YTDLP_LINUX_X64_SHA256 =
  "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a";

export interface VideoDownloadPayload {
  v: 1;
  source_url: string;
  file_name: string;
  max_height: number;
  max_bytes: number;
  iat: number;
  exp: number;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function videoSecret(): string {
  const value =
    process.env.VIDEO_DOWNLOAD_SECRET?.trim() ||
    process.env.MCP_AUTH_TOKEN?.trim();
  if (!value) {
    throw new Error(
      "VIDEO_DOWNLOAD_SECRET or MCP_AUTH_TOKEN is required for hosted video downloads.",
    );
  }
  return value;
}

function hmac(value: string): string {
  return createHmac("sha256", videoSecret())
    .update(value)
    .digest("base64url");
}

export function sanitizeVideoFileName(value: string): string {
  const base = value
    .replace(/\.mp4$/i, "")
    .replace(/[\r\n]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "module-video";
  return base + ".mp4";
}

function configuredMaxVideoBytes(): number {
  const raw = Number(process.env.CANVAS_MAX_VIDEO_MB || DEFAULT_MAX_VIDEO_MB);
  const mb = Number.isFinite(raw) && raw > 0
    ? Math.min(raw, 1024)
    : DEFAULT_MAX_VIDEO_MB;
  return Math.floor(mb * 1024 * 1024);
}

export function signVideoDownload(args: {
  sourceUrl: string;
  fileName: string;
  maxHeight?: number;
  maxBytes?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: VideoDownloadPayload = {
    v: 1,
    source_url: args.sourceUrl,
    file_name: sanitizeVideoFileName(args.fileName),
    max_height: Math.max(144, Math.min(args.maxHeight || 720, 1080)),
    max_bytes: Math.max(
      1024 * 1024,
      Math.min(args.maxBytes || configuredMaxVideoBytes(), 1024 * 1024 * 1024),
    ),
    iat: now,
    exp: now + VIDEO_TOKEN_TTL_SECONDS,
  };

  const encoded = base64urlJson(payload);
  return encoded + "." + hmac(encoded);
}

export function verifyVideoDownloadToken(
  raw: string,
): VideoDownloadPayload | null {
  const [encoded, signature, ...rest] = raw.split(".");
  if (!encoded || !signature || rest.length) return null;
  if (!safeEqual(signature, hmac(encoded))) return null;

  let payload: VideoDownloadPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as VideoDownloadPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.v !== 1 ||
    typeof payload.source_url !== "string" ||
    typeof payload.file_name !== "string" ||
    typeof payload.max_height !== "number" ||
    typeof payload.max_bytes !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    return null;
  }

  return payload;
}

export function hostedPublicOrigin(): string {
  const configured = process.env.MCP_PUBLIC_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;

  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim();
  if (vercel) {
    return new URL(
      vercel.startsWith("http://") || vercel.startsWith("https://")
        ? vercel
        : "https://" + vercel,
    ).origin;
  }

  throw new Error(
    "A hosted public origin is required for video file links. Set MCP_PUBLIC_ORIGIN when not running on Vercel.",
  );
}

export function createVideoResourceUrl(args: {
  sourceUrl: string;
  fileName: string;
  maxHeight?: number;
}): string {
  const token = signVideoDownload({
    sourceUrl: args.sourceUrl,
    fileName: args.fileName,
    maxHeight: args.maxHeight,
  });
  return hostedPublicOrigin() + "/media/video?token=" + encodeURIComponent(token);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255,
    )
  ) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;

  const mapped = normalized.match(
    /::ffff:(\d+\.\d+\.\d+\.\d+)$/,
  );
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export async function assertPublicVideoSource(
  input: string,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Video URL is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Video URLs must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Video URLs must not contain embedded credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Refusing to download video from localhost.");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(
        "Refusing to download video from a private or local network address.",
      );
    }
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not resolve the video host.");
  }

  if (
    !addresses.length ||
    addresses.some((entry) => isPrivateAddress(entry.address))
  ) {
    throw new Error(
      "Refusing to download video from a private or local network address.",
    );
  }

  return url;
}

function normalizeCandidateUrl(raw: string): string | null {
  const cleaned = raw
    .replace(/&amp;/g, "&")
    .replace(/[),.;]+$/g, "")
    .trim();

  try {
    const url = new URL(cleaned);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function looksLikeVideoUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com") ||
    host === "vimeo.com" ||
    host.endsWith(".vimeo.com")
  ) {
    return true;
  }

  return /\.(mp4|webm|mov|m4v|m3u8)(?:$|[?#])/i.test(
    url.pathname + url.search + url.hash,
  );
}

export function extractVideoUrls(value: unknown): string[] {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? {});
  const matches = text.match(/https:\/\/[^\s"'<>\\]+/gi) || [];
  const output: string[] = [];

  for (const raw of matches) {
    const normalized = normalizeCandidateUrl(raw);
    if (!normalized) continue;

    const url = new URL(normalized);
    if (!looksLikeVideoUrl(url)) continue;
    if (!output.includes(normalized)) output.push(normalized);
  }

  return output;
}

export function isDirectVideoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(
      url.pathname + url.search + url.hash,
    );
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await import("node:fs/promises").then((fs) =>
    fs.readFile(path),
  );
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureYtDlpBinary(): Promise<string> {
  const configured = process.env.YTDLP_BINARY_PATH?.trim();
  if (configured) return configured;

  if (process.platform !== "linux" || process.arch !== "x64") {
    return "yt-dlp";
  }

  const path = "/tmp/canvas-mcp-yt-dlp-" + YTDLP_VERSION;

  if (
    await fileExists(path) &&
    (await sha256File(path)) === YTDLP_LINUX_X64_SHA256
  ) {
    await chmod(path, 0o755);
    return path;
  }

  const response = await fetch(YTDLP_LINUX_X64_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(90_000),
    headers: {
      "User-Agent": "canvas-mcp/0.1.0",
      Accept: "application/octet-stream",
    },
  });

  if (!response.ok) {
    throw new Error(
      "Could not bootstrap the pinned yt-dlp binary for this server.",
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== YTDLP_LINUX_X64_SHA256) {
    throw new Error("yt-dlp binary checksum verification failed.");
  }

  await writeFile(path, bytes, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

export function ytDlpFormat(maxHeight: number): string {
  const height = Math.max(144, Math.min(maxHeight, 1080));
  return [
    `best[ext=mp4][height<=${height}]`,
    "best[ext=mp4]",
    `best[height<=${height}]`,
    "best",
  ].join("/");
}
