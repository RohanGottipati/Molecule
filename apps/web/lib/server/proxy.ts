import { MAX_CONTEXT_BYTES } from "@molecule/contracts";

const readPaths = [
  /^marketplace$/,
  /^desktop\/config$/,
  /^orders\/[^/]+(?:\/events)?$/,
  /^projects\/[^/]+$/,
];
const writePaths = [
  /^orders$/,
  /^orders\/[^/]+\/(?:messages|approve)$/,
  /^projects\/[^/]+\/(?:context|actions)$/,
  /^chaos$/,
];

function failure(status: number, message: string) {
  return Response.json({ message }, { status });
}

export async function proxyRequest(
  request: Request,
  segments: string[],
  backend = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3001",
): Promise<Response> {
  if (segments.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment)))
    return failure(404, "Route not found");
  const path = segments.join("/");
  const allowed = request.method === "GET" ? readPaths : writePaths;
  if (
    !["GET", "POST"].includes(request.method) ||
    !allowed.some((rule) => rule.test(path))
  )
    return failure(404, "Route not found");
  const origin = request.headers.get("origin");
  if (request.method === "POST") {
    const host =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
      request.headers.get("host") ??
      new URL(request.url).host;
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return failure(403, "Origin not allowed");
    try {
      if (origin && new URL(origin).host !== host)
        return failure(403, "Origin not allowed");
    } catch {
      return failure(403, "Origin not allowed");
    }
  }
  let target: URL;
  try {
    target = new URL(backend);
  } catch {
    return failure(503, "Invalid service configuration");
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    return failure(503, "Invalid service configuration");
  target.pathname = `/api/${path}`;
  target.search = "";
  const headers = new Headers();
  for (const name of [
    "content-type",
    "last-event-id",
    "x-action-id",
    "x-action-key",
    "x-trace-id",
    "x-file-name",
    "x-file-type",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (request.method === "GET" && /^orders\/[^/]+\/events$/.test(path)) {
    const after = new URL(request.url).searchParams.get("after");
    if (after !== null) {
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
        return failure(400, "Invalid event cursor");
      if (!headers.has("last-event-id")) headers.set("last-event-id", after);
    }
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(), 125_000);
  try {
    let body: ArrayBuffer | undefined;
    if (request.method === "POST") {
      if (Number(request.headers.get("content-length")) > MAX_CONTEXT_BYTES)
        return failure(413, "File exceeds 10 MB");
      const chunks: Uint8Array[] = [];
      const reader = request.body?.getReader();
      let length = 0;
      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > MAX_CONTEXT_BYTES) {
            await reader.cancel();
            return failure(413, "File exceeds 10 MB");
          }
          chunks.push(next.value);
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = bytes.buffer;
    }
    const response = await fetch(target, {
      method: request.method,
      body,
      headers,
      signal,
      cache: "no-store",
      redirect: "error",
    });
    const stream = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    const responseBody = stream ? response.body : await response.arrayBuffer();
    return new Response(responseBody, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store, no-transform",
        ...(stream ? { "X-Accel-Buffering": "no" } : {}),
      },
    });
  } catch {
    return failure(signal.aborted ? 504 : 502, "Orchestrator unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
