import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { CanvasMcpConfig, WriteMode } from "./config.js";

export type Primitive = string | number | boolean | null;
export type QueryValue = Primitive | Primitive[] | undefined;
export type Query = Record<string, QueryValue>;
export type JsonObject = Record<string, unknown>;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiResult<T = unknown> {
  data: T;
  status: number;
  headers: Record<string, string>;
  pages?: number;
}

export class CanvasApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CanvasApiError";
  }
}

function queryValue(value: Primitive): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function appendQuery(url: URL, query?: Query): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const queryKey = key.endsWith("[]") ? key : `${key}[]`;
      for (const item of value) url.searchParams.append(queryKey, queryValue(item));
    } else {
      url.searchParams.append(key, queryValue(value));
    }
  }
}

function flattenForm(value: unknown, prefix: string, out: URLSearchParams): void {
  if (value === undefined) return;
  if (value === null) {
    out.append(prefix, "");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenForm(item, `${prefix}[]`, out);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      flattenForm(nested, prefix ? `${prefix}[${key}]` : key, out);
    }
    return;
  }
  out.append(prefix, typeof value === "boolean" ? (value ? "true" : "false") : String(value));
}

export function toFormBody(value: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, nested] of Object.entries(value)) flattenForm(nested, key, out);
  return out;
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function mimeTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

const STUDENT_MUTATION_PATTERNS: RegExp[] = [
  /^\/api\/v1\/courses\/[^/]+\/assignments\/[^/]+\/submissions(?:\/self\/files)?$/,
  /^\/api\/v1\/courses\/[^/]+\/discussion_topics\/[^/]+\/entries(?:\/[^/]+\/replies)?$/,
  /^\/api\/v1\/(?:courses|groups)\/[^/]+\/discussion_topics\/[^/]+\/(?:read|read_all|subscribed)$/,
  /^\/api\/v1\/(?:courses|groups)\/[^/]+\/discussion_topics\/[^/]+\/entries\/[^/]+\/read$/,
  /^\/api\/v1\/courses\/[^/]+\/assignments\/[^/]+\/submissions\/self\/read\/[^/]+$/,
  /^\/api\/v1\/courses\/[^/]+\/submissions\/self\/clear_unread$/,
  /^\/api\/v1\/courses\/[^/]+\/modules\/[^/]+\/items\/[^/]+\/(?:done|mark_read|select_mastery_path)$/,
  /^\/api\/v1\/users\/self\/files(?:\/[^/]+)?$/,
  /^\/api\/v1\/planner(?:\/overrides(?:\/[^/]+)?)?$/,
  /^\/api\/v1\/calendar_events(?:\/[^/]+)?$/,
  /^\/api\/v1\/conversations(?:\/[^/]+)?(?:\/add_recipients)?$/,
  /^\/api\/v1\/users\/self\/communication_channels(?:\/[^/]+)?$/,
];

function isStudentMutationAllowed(path: string): boolean {
  return STUDENT_MUTATION_PATTERNS.some((pattern) => pattern.test(path));
}

export class CanvasClient {
  readonly baseUrl: URL;
  readonly writeMode: WriteMode;
  readonly maxPages: number;
  readonly timeoutMs: number;

  constructor(private readonly config: CanvasMcpConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.writeMode = config.writeMode;
    this.maxPages = config.maxPages;
    this.timeoutMs = config.timeoutMs;
  }

  private canvasUrl(pathOrUrl: string, query?: Query): URL {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`, this.baseUrl);

    if (url.origin !== this.baseUrl.origin) {
      throw new CanvasApiError("Refusing to send Canvas credentials to a different origin.");
    }
    if (!url.pathname.startsWith("/api/")) {
      throw new CanvasApiError("Canvas API path must begin with /api/.");
    }
    appendQuery(url, query);
    return url;
  }

  private assertMutationAllowed(method: HttpMethod, path: string): void {
    if (method === "GET") return;
    if (this.writeMode === "full") return;
    if (this.writeMode === "read_only") {
      throw new CanvasApiError("This Canvas MCP is configured as read_only.");
    }
    if (!isStudentMutationAllowed(path)) {
      throw new CanvasApiError(
        `Write mode student blocks this mutation: ${method} ${path}. Set CANVAS_WRITE_MODE=full if you intentionally want arbitrary Canvas writes.`,
      );
    }
  }

  private async parseResponse(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return response.json();
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: {
      query?: Query;
      body?: JsonObject;
      bodyEncoding?: "form" | "json";
      paginate?: boolean;
      maxPages?: number;
    } = {},
  ): Promise<ApiResult<T>> {
    const first = this.canvasUrl(path, options.query);
    this.assertMutationAllowed(method, first.pathname);

    const allData: unknown[] = [];
    let nextUrl: URL | undefined = first;
    let pages = 0;
    let lastHeaders: Headers | undefined;
    let lastStatus = 200;

    while (nextUrl) {
      pages += 1;
      const headers = new Headers({
        Accept: "application/json+canvas-string-ids",
        Authorization: `Bearer ${this.config.accessToken}`,
        "User-Agent": "canvas-mcp/0.1.0",
      });

      let body: BodyInit | undefined;
      if (options.body && method !== "GET") {
        if (options.bodyEncoding === "json") {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify(options.body);
        } else {
          headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
          body = toFormBody(options.body);
        }
      }

      const response = await fetch(nextUrl, {
        method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      lastHeaders = response.headers;
      lastStatus = response.status;
      const data = await this.parseResponse(response);

      if (!response.ok) {
        throw new CanvasApiError(
          `Canvas API request failed with HTTP ${response.status} ${response.statusText}.`,
          response.status,
          data,
        );
      }

      if (!options.paginate) {
        return {
          data: data as T,
          status: response.status,
          headers: headersObject(response.headers),
          pages: 1,
        };
      }

      if (Array.isArray(data)) allData.push(...data);
      else if (pages === 1) return { data: data as T, status: response.status, headers: headersObject(response.headers), pages: 1 };

      const next = parseLinkHeader(response.headers.get("link")).next;
      if (!next || pages >= (options.maxPages ?? this.maxPages)) break;
      const candidate = this.canvasUrl(next);
      nextUrl = candidate;
    }

    return {
      data: allData as T,
      status: lastStatus,
      headers: headersObject(lastHeaders || new Headers()),
      pages,
    };
  }

  get<T = unknown>(path: string, query?: Query, paginate = false): Promise<ApiResult<T>> {
    return this.request<T>("GET", path, { query, paginate });
  }

  post<T = unknown>(path: string, body?: JsonObject): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, { body });
  }

  put<T = unknown>(path: string, body?: JsonObject): Promise<ApiResult<T>> {
    return this.request<T>("PUT", path, { body });
  }

  delete<T = unknown>(path: string, body?: JsonObject): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path, { body });
  }

  async downloadFile(fileId: string, destinationPath?: string): Promise<Record<string, unknown>> {
    const metadata = await this.get<Record<string, unknown>>(`/api/v1/files/${encodeURIComponent(fileId)}`);
    const fileUrl = metadata.data.url;
    if (typeof fileUrl !== "string" || !fileUrl) {
      throw new CanvasApiError("Canvas file metadata did not include a download URL.", metadata.status, metadata.data);
    }

    let current = new URL(fileUrl, this.baseUrl);
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount < 10; redirectCount += 1) {
      const headers = new Headers({ "User-Agent": "canvas-mcp/0.1.0" });
      if (current.origin === this.baseUrl.origin) {
        headers.set("Authorization", `Bearer ${this.config.accessToken}`);
      }
      response = await fetch(current, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new CanvasApiError("Canvas file download redirect had no Location header.");
      current = new URL(location, current);
    }

    if (!response || !response.ok) {
      const details = response ? await this.parseResponse(response) : undefined;
      throw new CanvasApiError(`Canvas file download failed${response ? ` with HTTP ${response.status}` : ""}.`, response?.status, details);
    }

    const displayName = typeof metadata.data.display_name === "string"
      ? metadata.data.display_name
      : typeof metadata.data.filename === "string"
        ? metadata.data.filename
        : `canvas-file-${fileId}`;
    const destination = resolve(destinationPath || resolve(process.cwd(), "canvas-downloads", displayName));
    await mkdir(dirname(destination), { recursive: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, bytes);

    return {
      path: destination,
      bytes: bytes.length,
      content_type: response.headers.get("content-type"),
      file: metadata.data,
    };
  }

  async uploadSubmissionFile(courseId: string, assignmentId: string, filePath: string): Promise<Record<string, unknown>> {
    if (this.writeMode === "read_only") throw new CanvasApiError("This Canvas MCP is configured as read_only.");

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new CanvasApiError(`Not a file: ${filePath}`);
    const name = basename(filePath);
    const contentType = mimeTypeFor(filePath);

    const init = await this.post<{
      upload_url: string;
      upload_params: Record<string, string>;
    }>(`/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self/files`, {
      name,
      size: fileStat.size,
      content_type: contentType,
    });

    if (!init.data?.upload_url || !init.data.upload_params) {
      throw new CanvasApiError("Canvas did not return upload_url and upload_params.", init.status, init.data);
    }

    const bytes = await readFile(filePath);
    const form = new FormData();
    for (const [key, value] of Object.entries(init.data.upload_params)) form.append(key, value);
    form.append("file", new Blob([bytes], { type: contentType }), name);

    const uploadResponse = await fetch(init.data.upload_url, {
      method: "POST",
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (![201, 301, 302, 303, 307, 308].includes(uploadResponse.status)) {
      const details = await this.parseResponse(uploadResponse);
      throw new CanvasApiError(`Canvas file upload failed with HTTP ${uploadResponse.status}.`, uploadResponse.status, details);
    }

    const location = uploadResponse.headers.get("location");
    if (!location) {
      const direct = await this.parseResponse(uploadResponse);
      if (direct && typeof direct === "object") return direct as Record<string, unknown>;
      throw new CanvasApiError("Canvas upload succeeded but did not provide a completion Location header.");
    }

    const completion = this.canvasUrl(location);
    const completeResponse = await fetch(completion, {
      method: "GET",
      headers: {
        Accept: "application/json+canvas-string-ids",
        Authorization: `Bearer ${this.config.accessToken}`,
        "User-Agent": "canvas-mcp/0.1.0",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const completed = await this.parseResponse(completeResponse);
    if (!completeResponse.ok) {
      throw new CanvasApiError(
        `Canvas upload completion failed with HTTP ${completeResponse.status}.`,
        completeResponse.status,
        completed,
      );
    }
    return completed as Record<string, unknown>;
  }
}
