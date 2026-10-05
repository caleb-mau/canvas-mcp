import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import {
  assertPublicVideoSource,
  ensureYtDlpBinary,
  isDirectVideoUrl,
  verifyVideoDownloadToken,
  ytDlpFormat,
} from "../../../src/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function contentDisposition(fileName: string): string {
  const ascii = fileName
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function limitedWebStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(
            new Error("Video exceeded the configured download size limit."),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function directVideoResponse(args: {
  sourceUrl: string;
  fileName: string;
  maxBytes: number;
}): Promise<Response> {
  let current = await assertPublicVideoSource(args.sourceUrl);
  let response: Response | undefined;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1",
        "User-Agent": "canvas-mcp/0.1.0",
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) break;

    const location = response.headers.get("location");
    if (!location) {
      return Response.json(
        { error: "Video source redirected without a Location header." },
        { status: 502 },
      );
    }
    if (redirects === 5) {
      return Response.json(
        { error: "Video source exceeded the redirect limit." },
        { status: 502 },
      );
    }

    current = await assertPublicVideoSource(
      new URL(location, current).toString(),
    );
  }

  if (!response || !response.ok || !response.body) {
    return Response.json(
      {
        error: response
          ? `Video source returned HTTP ${response.status}.`
          : "Video source did not return a response.",
      },
      { status: 502 },
    );
  }

  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > args.maxBytes) {
    return Response.json(
      { error: "Video exceeds the configured download size limit." },
      { status: 413 },
    );
  }

  return new Response(
    limitedWebStream(response.body, args.maxBytes),
    {
      status: 200,
      headers: {
        "Content-Type":
          response.headers.get("content-type") || "video/mp4",
        "Content-Disposition": contentDisposition(args.fileName),
        "Cache-Control": "private, no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

async function ytDlpResponse(args: {
  sourceUrl: string;
  fileName: string;
  maxHeight: number;
  maxBytes: number;
}): Promise<Response> {
  await assertPublicVideoSource(args.sourceUrl);
  const binary = await ensureYtDlpBinary();
  const maxMb = Math.max(1, Math.floor(args.maxBytes / 1024 / 1024));

  const child = spawn(
    binary,
    [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--quiet",
      "--js-runtimes",
      "node",
      "--max-filesize",
      `${maxMb}M`,
      "--format",
      ytDlpFormat(args.maxHeight),
      "--output",
      "-",
      "--",
      args.sourceUrl,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8_000) stderr += chunk;
  });

  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > args.maxBytes) {
        child.kill("SIGKILL");
        callback(
          new Error("Video exceeded the configured download size limit."),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  child.stdout.pipe(limiter);

  child.once("close", (code) => {
    if (code && code !== 0 && total === 0) {
      limiter.destroy(
        new Error(
          stderr.trim() ||
            "yt-dlp could not retrieve this video.",
        ),
      );
    }
  });

  const body = Readable.toWeb(limiter) as ReadableStream<Uint8Array>;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": contentDisposition(args.fileName),
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return Response.json(
      { error: "Missing video download token." },
      { status: 400 },
    );
  }

  let payload;
  try {
    payload = verifyVideoDownloadToken(token);
  } catch {
    return Response.json(
      { error: "Video download service is not configured." },
      { status: 503 },
    );
  }

  if (!payload) {
    return Response.json(
      { error: "Video download link is invalid or expired." },
      { status: 403 },
    );
  }

  try {
    if (isDirectVideoUrl(payload.source_url)) {
      return await directVideoResponse({
        sourceUrl: payload.source_url,
        fileName: payload.file_name,
        maxBytes: payload.max_bytes,
      });
    }

    return await ytDlpResponse({
      sourceUrl: payload.source_url,
      fileName: payload.file_name,
      maxHeight: payload.max_height,
      maxBytes: payload.max_bytes,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Video download failed.",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
