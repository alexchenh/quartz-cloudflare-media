import type {
  CloudflareMediaOptions,
  ResolvedCloudflareMediaOptions,
} from "./types.js";

export const REMOTE_MEDIA_MODE = "remote";

export function isRemoteMediaBuild(): boolean {
  return process.env.CLOUDFLARE_MEDIA_MODE === REMOTE_MEDIA_MODE;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function origin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must be an absolute HTTPS origin without credentials, query, or fragment`,
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

export function resolveOptions(
  input: CloudflareMediaOptions,
): ResolvedCloudflareMediaOptions {
  if (input.backend !== "worker" && input.backend !== "direct-r2") {
    throw new Error('backend must be "worker" or "direct-r2"');
  }
  if (!input.publicOrigin) throw new Error("publicOrigin is required");
  if (input.backend === "direct-r2" && !input.bucketName) {
    throw new Error("bucketName is required for direct-r2");
  }
  const imageWidths = [...new Set(input.imageWidths ?? [640, 1280, 1920])]
    .map((value) => positiveInteger(value, "imageWidths"))
    .sort((a, b) => a - b);
  const defaultImageWidth = positiveInteger(
    input.defaultImageWidth ?? 1280,
    "defaultImageWidth",
  );
  if (!imageWidths.includes(defaultImageWidth))
    imageWidths.push(defaultImageWidth);

  return {
    backend: input.backend,
    publicOrigin: origin(input.publicOrigin, "publicOrigin"),
    imageTransformOrigin: origin(
      input.imageTransformOrigin ?? input.publicOrigin,
      "imageTransformOrigin",
    ),
    bucketName: input.bucketName,
    keyPrefix: (input.keyPrefix ?? "v1").replace(/^\/+|\/+$/g, ""),
    contentDirectory: input.contentDirectory ?? "content",
    outputDirectory: input.outputDirectory ?? "public",
    cacheDirectory: input.cacheDirectory ?? ".quartz-cache",
    manifestFilename:
      input.manifestFilename ?? "cloudflare-media-manifest.json",
    ignorePatterns: input.ignorePatterns ?? [
      "private",
      "templates",
      ".obsidian",
    ],
    excludeDrafts: input.excludeDrafts ?? true,
    imageWidths,
    defaultImageWidth,
    imageQuality: positiveInteger(input.imageQuality ?? 88, "imageQuality"),
    imageSizes: input.imageSizes ?? "(max-width: 800px) 100vw, 800px",
    uploadConcurrency: positiveInteger(
      input.uploadConcurrency ?? 4,
      "uploadConcurrency",
    ),
    multipartConcurrency: positiveInteger(
      input.multipartConcurrency ?? 2,
      "multipartConcurrency",
    ),
    multipartPartSize: positiveInteger(
      input.multipartPartSize ?? 95 * 1024 * 1024,
      "multipartPartSize",
    ),
    workerUploadTokenEnvironment:
      input.workerUploadTokenEnvironment ?? "CLOUDFLARE_MEDIA_UPLOAD_TOKEN",
  };
}
