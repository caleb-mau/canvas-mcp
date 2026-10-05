import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, extname, resolve } from "node:path";
import type { CanvasMcpConfig, WriteMode } from "./config";

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

export interface RemoteFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
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

function remoteFileLimitBytes(): number {
  const configured = Number(process.env.CANVAS_MAX_REMOTE_FILE_MB || "50");
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : 50;
  return Math.floor(megabytes * 1024 * 1024);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
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

  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function assertPublicHttpsUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CanvasApiError("File download URL is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new CanvasApiError("Remote file download URLs must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new CanvasApiError("Remote file download URLs must not contain embedded credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new CanvasApiError("Refusing to download a remote file from localhost.");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new CanvasApiError("Refusing to download a remote file from a private or local network address.");
    }
    return url;
  }

  let addresses: Awaited<ReturnType<typeof lookup>>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new CanvasApiError("Could not resolve the remote file host.");
  }

  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new CanvasApiError("Refusing to download a remote file whose host resolves to a private or local network address.");
  }

  return url;
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CanvasApiError(`Remote file exceeds the configured ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CanvasApiError(`Remote file exceeds the configured ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function isTeacherMutationAllowed(path: string): boolean {
  return (
    /^\/api\/v1\/(?:courses|sections|groups)\/[^/]+(?:\/.*)?$/.test(path) ||
    /^\/api\/v1\/conversations(?:\/.*)?$/.test(path) ||
    /^\/api\/v1\/calendar_events(?:\/.*)?$/.test(path) ||
    /^\/api\/v1\/planner(?:\/.*)?$/.test(path) ||
    /^\/api\/v1\/users\/self(?:\/.*)?$/.test(path)
  );
}

interface StudentIdentity {
  userId: string;
  courseId: string;
  courseAlias: string;
  globalAlias: string;
  identifiers: string[];
}

function courseIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/api\/v1\/courses\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length >= 3
  ).map((value) => value.trim()))];
}

function replaceKnownIdentifiers(value: string, identities: StudentIdentity[], courseScoped: boolean): string {
  let output = value;
  const replacements = identities
    .flatMap((identity) => identity.identifiers.map((identifier) => ({
      identifier,
      alias: courseScoped ? identity.courseAlias : identity.globalAlias,
    })))
    .sort((a, b) => b.identifier.length - a.identifier.length);

  for (const { identifier, alias } of replacements) {
    if (output.includes(identifier)) output = output.split(identifier).join(alias);
  }
  return output;
}

const USER_ID_KEYS = new Set(["user_id", "student_id", "author_id", "recipient_id", "grader_id"]);
const USER_NAME_KEYS = new Set(["name", "short_name", "sortable_name", "display_name", "user_name", "author_name"]);
const USER_PRIVATE_KEYS = new Set([
  "login_id",
  "sis_user_id",
  "sis_login_id",
  "email",
  "avatar_url",
  "integration_id",
]);

export class CanvasClient {
  readonly baseUrl: URL;
  readonly writeMode: WriteMode;
  readonly maxPages: number;
  readonly timeoutMs: number;
  private readonly studentRosterCache = new Map<string, Promise<StudentIdentity[]>>();
  private allStudentsCache?: Promise<StudentIdentity[]>;

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
    if (this.writeMode === "teacher") {
      if (isTeacherMutationAllowed(path)) return;
      throw new CanvasApiError(
        `Write mode teacher blocks account-level or administrative mutation: ${method} ${path}. Use CANVAS_WRITE_MODE=full only if you intentionally want unrestricted Canvas writes.`,
      );
    }
    if (!isStudentMutationAllowed(path)) {
      throw new CanvasApiError(
        `Write mode student blocks this mutation: ${method} ${path}. Set CANVAS_WRITE_MODE=full if you intentionally want arbitrary Canvas writes.`,
      );
    }
  }

  private aliasFor(courseId: string, userId: string, scope: "course" | "global"): string {
    const digest = createHmac("sha256", this.config.redactionKey)
      .update(`${this.baseUrl.origin}|${scope === "course" ? `course:${courseId}` : "global"}|user:${userId}`)
      .digest("base64url")
      .slice(0, 10);
    return scope === "course" ? `student_${digest}` : `student_global_${digest}`;
  }

  private async courseStudents(courseId: string): Promise<StudentIdentity[]> {
    const cached = this.studentRosterCache.get(courseId);
    if (cached) return cached;

    const pending = (async () => {
      const result = await this.request<Record<string, unknown>[]>(
        "GET",
        `/api/v1/courses/${encodeURIComponent(courseId)}/enrollments`,
        {
          query: {
            type: ["StudentEnrollment"],
            include: ["current_points"],
            per_page: 100,
          },
          paginate: true,
          redact: false,
        },
      );

      const byUser = new Map<string, StudentIdentity>();
      for (const enrollment of result.data) {
        const user = enrollment.user && typeof enrollment.user === "object"
          ? enrollment.user as Record<string, unknown>
          : {};
        const rawId = enrollment.user_id ?? user.id;
        if (rawId === undefined || rawId === null) continue;
        const userId = String(rawId);

        const identity: StudentIdentity = {
          userId,
          courseId,
          courseAlias: this.aliasFor(courseId, userId, "course"),
          globalAlias: this.aliasFor(courseId, userId, "global"),
          identifiers: uniqueStrings([
            user.name,
            user.short_name,
            user.sortable_name,
            user.display_name,
            user.login_id,
            user.sis_user_id,
            user.sis_login_id,
            user.email,
            enrollment.sis_user_id,
          ]),
        };

        const existing = byUser.get(userId);
        if (existing) {
          existing.identifiers = uniqueStrings([...existing.identifiers, ...identity.identifiers]);
        } else {
          byUser.set(userId, identity);
        }
      }
      return [...byUser.values()];
    })();

    this.studentRosterCache.set(courseId, pending);
    return pending;
  }

  private async allTeacherStudents(): Promise<StudentIdentity[]> {
    if (this.allStudentsCache) return this.allStudentsCache;

    this.allStudentsCache = (async () => {
      const courses = await this.request<Record<string, unknown>[]>(
        "GET",
        "/api/v1/courses",
        {
          query: {
            enrollment_type: "teacher",
            enrollment_state: "active",
            per_page: 100,
          },
          paginate: true,
          redact: false,
        },
      );

      const rosters = await Promise.all(
        courses.data
          .map((course) => course.id)
          .filter((courseId): courseId is string | number => courseId !== undefined && courseId !== null)
          .map((courseId) => this.courseStudents(String(courseId))),
      );

      const deduped = new Map<string, StudentIdentity>();
      for (const identity of rosters.flat()) {
        const existing = deduped.get(identity.userId);
        if (existing) {
          existing.identifiers = uniqueStrings([...existing.identifiers, ...identity.identifiers]);
        } else {
          deduped.set(identity.userId, identity);
        }
      }
      return [...deduped.values()];
    })();

    return this.allStudentsCache;
  }

  private redactWithIdentities(value: unknown, identities: StudentIdentity[], courseScoped: boolean): unknown {
    const byId = new Map(identities.map((identity) => [
      identity.userId,
      courseScoped ? identity.courseAlias : identity.globalAlias,
    ]));

    const visit = (current: unknown): unknown => {
      if (Array.isArray(current)) return current.map(visit);
      if (typeof current === "string") return replaceKnownIdentifiers(current, identities, courseScoped);
      if (!current || typeof current !== "object") return current;

      const object = current as Record<string, unknown>;
      const explicitLinkedId = ["user_id", "student_id", "author_id", "recipient_id"]
        .map((key) => object[key])
        .find((raw) => raw !== undefined && raw !== null && byId.has(String(raw)));
      const looksLikeUserObject = [...USER_NAME_KEYS, ...USER_PRIVATE_KEYS]
        .some((key) => key in object);
      const objectId = object.id;
      const linkedId = explicitLinkedId ?? (
        looksLikeUserObject &&
        objectId !== undefined &&
        objectId !== null &&
        byId.has(String(objectId))
          ? objectId
          : undefined
      );
      const linkedAlias = linkedId === undefined ? undefined : byId.get(String(linkedId));
      const output: Record<string, unknown> = {};

      for (const [key, raw] of Object.entries(object)) {
        if (USER_ID_KEYS.has(key) && raw !== undefined && raw !== null) {
          const alias = byId.get(String(raw));
          output[key] = alias ?? visit(raw);
          continue;
        }

        if (key === "id" && linkedAlias) {
          output[key] = linkedAlias;
          continue;
        }

        if (linkedAlias && USER_NAME_KEYS.has(key)) {
          output[key] = linkedAlias;
          continue;
        }

        if (linkedAlias && USER_PRIVATE_KEYS.has(key)) {
          output[key] = "[redacted]";
          continue;
        }

        output[key] = visit(raw);
      }

      return output;
    };

    return visit(value);
  }

  private async redactForTeacher(value: unknown, path: string, enabled: boolean): Promise<unknown> {
    if (!enabled || this.writeMode !== "teacher") return value;
    if (path === "/api/v1/users/self/profile") return value;

    const courseId = courseIdFromPath(path);
    if (courseId) {
      return this.redactWithIdentities(
        value,
        await this.courseStudents(courseId),
        true,
      );
    }

    const identities = (await this.allTeacherStudents()).map((identity) => ({
      ...identity,
      courseAlias: this.aliasFor("context:" + path, identity.userId, "course"),
    }));

    return this.redactWithIdentities(value, identities, true);
  }

  requireTeacherMode(): void {
    if (this.writeMode !== "teacher") {
      throw new CanvasApiError("This tool requires CANVAS_WRITE_MODE=teacher so student identity redaction is guaranteed.");
    }
  }

  async teacherStudents(
    courseId: string,
    includeAcademicContext = false,
  ): Promise<Record<string, unknown>[]> {
    this.requireTeacherMode();

    const raw = await this.request<Record<string, unknown>[]>(
      "GET",
      `/api/v1/courses/${encodeURIComponent(courseId)}/enrollments`,
      {
        query: {
          type: ["StudentEnrollment"],
          include: ["current_points"],
          per_page: 100,
        },
        paginate: true,
        redact: false,
      },
    );
    const identities = await this.courseStudents(courseId);
    const byId = new Map(identities.map((identity) => [identity.userId, identity.courseAlias]));

    return raw.data.map((enrollment) => {
      const user = enrollment.user && typeof enrollment.user === "object"
        ? enrollment.user as Record<string, unknown>
        : {};
      const rawId = enrollment.user_id ?? user.id;
      const studentRef = rawId === undefined || rawId === null ? undefined : byId.get(String(rawId));
      return {
        student_ref: studentRef,
        enrollment_state: enrollment.enrollment_state,
        course_section_id: enrollment.course_section_id,
        ...(includeAcademicContext
          ? {
              grades: enrollment.grades,
              last_activity_at: enrollment.last_activity_at,
              total_activity_time: enrollment.total_activity_time,
            }
          : {}),
      };
    }).filter((item) => item.student_ref);
  }

  async resolveStudentRef(courseId: string, studentRef: string): Promise<string> {
    this.requireTeacherMode();
    if (!studentRef.startsWith("student_")) {
      throw new CanvasApiError("Teacher tools require a redacted student_ref, not a raw Canvas user id.");
    }

    const identities = await this.courseStudents(courseId);
    const identity = identities.find((candidate) =>
      candidate.courseAlias === studentRef
    );
    if (!identity) {
      throw new CanvasApiError("Could not resolve that student_ref in this course.");
    }
    return identity.userId;
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
      redact?: boolean;
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
        const protectedData = await this.redactForTeacher(
          data,
          first.pathname,
          options.redact !== false,
        );
        return {
          data: protectedData as T,
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

    const protectedData = await this.redactForTeacher(
      allData,
      first.pathname,
      options.redact !== false,
    );

    return {
      data: protectedData as T,
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

  private async uploadSubmissionBytes(
    courseId: string,
    assignmentId: string,
    file: {
      name: string;
      contentType: string;
      bytes: Uint8Array;
    },
  ): Promise<Record<string, unknown>> {
    if (this.writeMode === "read_only") {
      throw new CanvasApiError("This Canvas MCP is configured as read_only.");
    }

    const init = await this.post<{
      upload_url: string;
      upload_params: Record<string, string>;
    }>(
      `/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self/files`,
      {
        name: file.name,
        size: file.bytes.byteLength,
        content_type: file.contentType,
      },
    );

    if (!init.data?.upload_url || !init.data.upload_params) {
      throw new CanvasApiError(
        "Canvas did not return upload_url and upload_params.",
        init.status,
        init.data,
      );
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(init.data.upload_params)) {
      form.append(key, value);
    }
    form.append(
      "file",
      new Blob([file.bytes], { type: file.contentType }),
      file.name,
    );

    const uploadResponse = await fetch(init.data.upload_url, {
      method: "POST",
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (![201, 301, 302, 303, 307, 308].includes(uploadResponse.status)) {
      const details = await this.parseResponse(uploadResponse);
      throw new CanvasApiError(
        `Canvas file upload failed with HTTP ${uploadResponse.status}.`,
        uploadResponse.status,
        details,
      );
    }

    const location = uploadResponse.headers.get("location");
    if (!location) {
      const direct = await this.parseResponse(uploadResponse);
      if (direct && typeof direct === "object") {
        return direct as Record<string, unknown>;
      }
      throw new CanvasApiError(
        "Canvas upload succeeded but did not provide a completion Location header.",
      );
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

  async uploadSubmissionFile(
    courseId: string,
    assignmentId: string,
    filePath: string,
  ): Promise<Record<string, unknown>> {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new CanvasApiError(`Not a file: ${filePath}`);
    }

    const name = basename(filePath);
    return this.uploadSubmissionBytes(courseId, assignmentId, {
      name,
      contentType: mimeTypeFor(filePath),
      bytes: await readFile(filePath),
    });
  }

  async uploadSubmissionFileReference(
    courseId: string,
    assignmentId: string,
    file: RemoteFileReference,
  ): Promise<Record<string, unknown>> {
    if (!file.download_url || !file.file_id) {
      throw new CanvasApiError(
        "Remote file references require download_url and file_id.",
      );
    }

    let current = await assertPublicHttpsUrl(file.download_url);
    let response: Response | undefined;

    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await fetch(current, {
        method: "GET",
        headers: {
          Accept: "application/octet-stream,*/*",
          "User-Agent": "canvas-mcp/0.1.0",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) break;

      const location = response.headers.get("location");
      if (!location) {
        throw new CanvasApiError(
          "Remote file download redirected without a Location header.",
        );
      }
      if (redirects === 5) {
        throw new CanvasApiError("Remote file download exceeded the redirect limit.");
      }
      current = await assertPublicHttpsUrl(new URL(location, current).toString());
    }

    if (!response || !response.ok) {
      throw new CanvasApiError(
        `Remote file download failed${response ? ` with HTTP ${response.status}` : ""}.`,
        response?.status,
      );
    }

    const bytes = await readResponseWithLimit(
      response,
      remoteFileLimitBytes(),
    );
    if (!bytes.byteLength) {
      throw new CanvasApiError("Remote file download returned an empty file.");
    }

    const rawName =
      file.file_name?.trim() ||
      basename(decodeURIComponent(current.pathname)) ||
      "submission-file";
    const name = basename(rawName).replace(/[\r\n]/g, "").slice(0, 255) || "submission-file";
    const contentType =
      file.mime_type?.trim() ||
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      mimeTypeFor(name);

    return this.uploadSubmissionBytes(courseId, assignmentId, {
      name,
      contentType,
      bytes,
    });
  }

}
