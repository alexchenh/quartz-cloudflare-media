import { validObjectKey } from "./keys";

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_STORE = { "cache-control": "no-store" };
const encoder = new TextEncoder();

function decodeKey(parts: string[]): string | undefined {
  try {
    const key = parts.map(decodeURIComponent).join("/");
    return validObjectKey(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const provided = encoder.encode(header.slice(7));
  const expected = encoder.encode(env.UPLOAD_TOKEN);
  return (
    provided.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(provided, expected)
  );
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", IMMUTABLE_CACHE);
  return headers;
}

async function original(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method === "HEAD") {
    const head = await env.MEDIA.head(key);
    return head
      ? new Response(null, { headers: objectHeaders(head) })
      : error(404, "Not found");
  }
  if (request.method !== "GET") return error(405, "Method not allowed");
  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return error(404, "Not found");
  const headers = objectHeaders(object);
  let status = 200;
  if (
    object.range &&
    "offset" in object.range &&
    object.range.offset !== undefined
  ) {
    const length = object.range.length ?? object.size - object.range.offset;
    headers.set(
      "content-range",
      `bytes ${object.range.offset}-${object.range.offset + length - 1}/${object.size}`,
    );
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, { status, headers });
}

function outputFormat(
  accept: string,
  sourceType: string | undefined,
): ImageOutputOptions["format"] {
  if (accept.includes("image/avif")) return "image/avif";
  if (accept.includes("image/webp")) return "image/webp";
  if (
    [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
    ].includes(sourceType ?? "")
  ) {
    return sourceType as ImageOutputOptions["format"];
  }
  return "image/jpeg";
}

async function transformedImage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  width: number,
  key: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return error(405, "Method not allowed");
  const allowed = new Set(env.IMAGE_WIDTHS.split(",").map(Number));
  if (!allowed.has(width)) return error(400, "Unsupported image width");
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  const accept = request.headers.get("accept") ?? "";
  cacheUrl.searchParams.set(
    "__format",
    accept.includes("image/avif")
      ? "avif"
      : accept.includes("image/webp")
        ? "webp"
        : "source",
  );
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached)
    return request.method === "HEAD" ? new Response(null, cached) : cached;
  const object = await env.MEDIA.get(key);
  if (!object) return error(404, "Not found");
  const result = await env.IMAGES.input(object.body)
    .transform({ width, fit: "scale-down" })
    .output({
      format: outputFormat(accept, object.httpMetadata?.contentType),
      quality: Number(env.IMAGE_QUALITY),
    });
  const response = result.response({
    headers: { "cache-control": IMMUTABLE_CACHE, vary: "Accept" },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return request.method === "HEAD" ? new Response(null, response) : response;
}

async function uploadRoute(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  if (request.method === "HEAD") {
    return (await env.MEDIA.head(key))
      ? new Response(null, { status: 204, headers: NO_STORE })
      : error(404, "Not found");
  }
  if (request.method === "DELETE") {
    await env.MEDIA.delete(key);
    return new Response(null, { status: 204, headers: NO_STORE });
  }
  if (request.method !== "PUT" || !request.body)
    return error(405, "Method not allowed");
  const sha256 = request.headers.get("x-content-sha256");
  if (!sha256 || !key.includes(`/${sha256}/`))
    return error(400, "Hash metadata does not match key");
  const object = await env.MEDIA.put(key, request.body, {
    httpMetadata: {
      contentType:
        request.headers.get("content-type") ?? "application/octet-stream",
      contentDisposition: "inline",
      cacheControl: IMMUTABLE_CACHE,
    },
    customMetadata: { sha256 },
  });
  return Response.json(
    { key: object.key, etag: object.etag },
    { status: 201, headers: NO_STORE },
  );
}

async function multipartRoute(
  request: Request,
  env: Env,
  parts: string[],
): Promise<Response> {
  const creating = parts[0] === "create";
  const uploadId = creating
    ? undefined
    : parts[0]
      ? decodeURIComponent(parts[0])
      : undefined;
  const action = creating ? "create" : parts[1];
  const keyParts = creating
    ? parts.slice(1)
    : action === "part"
      ? parts.slice(3)
      : parts.slice(2);
  const key = decodeKey(keyParts);
  if (!key) return error(400, "Invalid object key");
  if (creating && request.method === "POST") {
    const sha256 = request.headers.get("x-content-sha256");
    if (!sha256 || !key.includes(`/${sha256}/`))
      return error(400, "Hash metadata does not match key");
    const upload = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: {
        contentType:
          request.headers.get("content-type") ?? "application/octet-stream",
        contentDisposition: "inline",
        cacheControl: IMMUTABLE_CACHE,
      },
      customMetadata: { sha256 },
    });
    return Response.json(
      { uploadId: upload.uploadId },
      { status: 201, headers: NO_STORE },
    );
  }
  if (!uploadId) return error(400, "Missing upload ID");
  const upload = env.MEDIA.resumeMultipartUpload(key, uploadId);
  if (
    request.method === "PUT" &&
    action === "part" &&
    /^\d+$/.test(parts[2] ?? "") &&
    request.body
  ) {
    const partNumber = Number(parts[2]);
    if (partNumber < 1 || partNumber > 10_000)
      return error(400, "Invalid part number");
    const part = await upload.uploadPart(partNumber, request.body);
    return Response.json(part, { status: 201, headers: NO_STORE });
  }
  if (request.method === "POST" && action === "complete") {
    const body: unknown = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { parts?: unknown }).parts)
    )
      return error(400, "Invalid multipart completion");
    const uploadedParts = (body as { parts: unknown[] }).parts;
    if (
      !uploadedParts.every(
        (part) =>
          part &&
          typeof part === "object" &&
          Number.isInteger((part as { partNumber?: unknown }).partNumber) &&
          typeof (part as { etag?: unknown }).etag === "string",
      )
    )
      return error(400, "Invalid multipart parts");
    const object = await upload.complete(uploadedParts as R2UploadedPart[]);
    return Response.json(
      { key: object.key, etag: object.etag },
      { headers: NO_STORE },
    );
  }
  if (request.method === "DELETE" && action === "abort") {
    await upload.abort();
    return new Response(null, { status: 204, headers: NO_STORE });
  }
  return error(405, "Method not allowed");
}

async function listObjects(request: Request, env: Env): Promise<Response> {
  const prefix = new URL(request.url).searchParams.get("prefix") ?? "v1/";
  if (!/^v[\w.-]+\/$/.test(prefix)) return error(400, "Invalid prefix");
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ keys }, { headers: NO_STORE });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1") return error(404, "Not found");
      if (
        ["upload", "multipart", "objects"].includes(parts[1] ?? "") &&
        !(await authorized(request, env))
      ) {
        return error(401, "Unauthorized");
      }
      if (parts[1] === "original") {
        const key = decodeKey(parts.slice(2));
        return key
          ? original(request, env, key)
          : error(400, "Invalid object key");
      }
      if (parts[1] === "image") {
        const width = Number(parts[2]);
        const key = decodeKey(parts.slice(3));
        return key && Number.isSafeInteger(width)
          ? transformedImage(request, env, ctx, width, key)
          : error(400, "Invalid image request");
      }
      if (parts[1] === "upload") {
        const key = decodeKey(parts.slice(2));
        return key
          ? uploadRoute(request, env, key)
          : error(400, "Invalid object key");
      }
      if (parts[1] === "multipart")
        return multipartRoute(request, env, parts.slice(2));
      if (parts[1] === "objects" && request.method === "GET")
        return listObjects(request, env);
      return error(404, "Not found");
    } catch (caught) {
      console.error(
        JSON.stringify({
          message: "request failed",
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      );
      return error(500, "Internal error");
    }
  },
} satisfies ExportedHandler<Env>;
