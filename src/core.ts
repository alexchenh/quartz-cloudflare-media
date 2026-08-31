import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { globby } from "globby";
import sharp from "sharp";
import YAML from "yaml";
import { slugifyFilePath, type FilePath } from "@quartz-community/utils/path";
import type {
  MediaKind,
  MediaManifest,
  MediaManifestEntry,
  MediaReference,
  ResolvedCloudflareMediaOptions,
} from "./types.js";

const IMAGE_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const VIDEO_MIME_TYPES = new Map([
  [".3gp", "video/3gpp"],
  [".avi", "video/x-msvideo"],
  [".flv", "video/x-flv"],
  [".m4v", "video/x-m4v"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".mpg", "video/mpeg"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
  [".wmv", "video/x-ms-wmv"],
]);

export const SUPPORTED_EXTENSIONS = new Set([
  ...IMAGE_MIME_TYPES.keys(),
  ...VIDEO_MIME_TYPES.keys(),
]);

const toPosix = (value: string): string => value.split(path.sep).join("/");
const stripUrlSuffix = (value: string): string => value.replace(/[?#].*$/, "");

function decodeTarget(value: string): string {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(stripUrlSuffix(trimmed));
  } catch {
    return stripUrlSuffix(trimmed);
  }
}

export function isExternalTarget(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value.trim());
}

export function mediaTypeForTarget(
  target: string,
): { kind: MediaKind; mimeType: string } | undefined {
  const extension = path.extname(decodeTarget(target)).toLowerCase();
  const image = IMAGE_MIME_TYPES.get(extension);
  if (image) return { kind: "image", mimeType: image };
  const video = VIDEO_MIME_TYPES.get(extension);
  return video ? { kind: "video", mimeType: video } : undefined;
}

function withoutCodeFences(markdown: string): string {
  return markdown.replace(
    /(^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?\n(?:```|~~~)(?=\n|$)/g,
    "$1",
  );
}

export function extractMediaTargets(markdown: string): string[] {
  const source = withoutCodeFences(markdown);
  const targets: string[] = [];
  for (const match of source.matchAll(
    /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g,
  )) {
    const target = match[1] ?? match[2];
    if (target) targets.push(target);
  }
  for (const match of source.matchAll(/!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    if (match[1]) targets.push(match[1]);
  }
  for (const match of source.matchAll(
    /<(?:img|video|source)\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi,
  )) {
    if (match[2]) targets.push(match[2]);
  }
  return targets.filter(
    (target) => mediaTypeForTarget(target) && !isExternalTarget(target),
  );
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return {};
  const parsed: unknown = YAML.parse(match[1]);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveMediaTarget(
  contentRoot: string,
  notePath: string,
  target: string,
  basenameIndex: Map<string, string[]>,
): Promise<string> {
  const decoded = decodeTarget(target).replace(/^\/+/, "");
  const contentAbsolute = path.resolve(contentRoot);
  for (const candidate of [
    path.resolve(path.dirname(notePath), decoded),
    path.resolve(contentAbsolute, decoded),
  ]) {
    if (
      candidate.startsWith(contentAbsolute + path.sep) &&
      (await exists(candidate))
    )
      return candidate;
  }
  const matches = basenameIndex.get(path.basename(decoded).toLowerCase()) ?? [];
  if (matches.length === 1 && matches[0]) return matches[0];
  const relativeNote = toPosix(path.relative(contentRoot, notePath));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous media reference ${JSON.stringify(target)} in ${relativeNote}: ${matches
        .map((candidate) => toPosix(path.relative(contentRoot, candidate)))
        .join(", ")}`,
    );
  }
  throw new Error(
    `Missing media reference ${JSON.stringify(target)} in ${relativeNote}`,
  );
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function slugFilename(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const base = path
    .basename(filePath, path.extname(filePath))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${base || "media"}${extension}`;
}

export function contentAddressedKey(
  filePath: string,
  sha256: string,
  options: ResolvedCloudflareMediaOptions,
): string {
  return `${options.keyPrefix}/${sha256}/${slugFilename(filePath)}`;
}

const encodedKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

export function originalUrlForKey(
  key: string,
  options: ResolvedCloudflareMediaOptions,
): string {
  const route =
    options.backend === "worker"
      ? `/v1/original/${encodedKey(key)}`
      : `/${encodedKey(key)}`;
  return `${options.publicOrigin}${route}`;
}

export function imageUrl(
  originalUrl: string,
  width: number,
  options: ResolvedCloudflareMediaOptions,
): string {
  if (options.backend === "worker") {
    const prefix = `${options.publicOrigin}/v1/original/`;
    if (!originalUrl.startsWith(prefix))
      throw new Error("Worker original URL does not match publicOrigin");
    return `${options.imageTransformOrigin}/v1/image/${width}/${originalUrl.slice(prefix.length)}`;
  }
  const transformations = [
    `width=${width}`,
    `quality=${options.imageQuality}`,
    "format=auto",
    "fit=scale-down",
    "metadata=none",
    "onerror=redirect",
  ].join(",");
  return `${options.imageTransformOrigin}/cdn-cgi/image/${transformations}/${originalUrl}`;
}

export function imageSrcSet(
  originalUrl: string,
  options: ResolvedCloudflareMediaOptions,
): string {
  return options.imageWidths
    .map((width) => `${imageUrl(originalUrl, width, options)} ${width}w`)
    .join(", ");
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) results[index] = await callback(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

export async function discoverManifest(
  rootDirectory: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<MediaManifest> {
  const contentRoot = path.resolve(rootDirectory, options.contentDirectory);
  const publishedFiles = await globby("**/*", {
    cwd: contentRoot,
    absolute: true,
    onlyFiles: true,
    ignore: options.ignorePatterns,
    gitignore: true,
  });
  const markdownFiles = publishedFiles.filter(
    (file) => path.extname(file).toLowerCase() === ".md",
  );
  const mediaFiles = publishedFiles.filter((file) =>
    SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  const basenameIndex = new Map<string, string[]>();
  for (const mediaFile of mediaFiles) {
    const basename = path.basename(mediaFile).toLowerCase();
    basenameIndex.set(basename, [
      ...(basenameIndex.get(basename) ?? []),
      mediaFile,
    ]);
  }

  const referencesByFile = new Map<string, MediaReference[]>();
  const publishedNotes: string[] = [];
  for (const noteFile of markdownFiles) {
    const markdown = await readFile(noteFile, "utf8");
    const draft = frontmatter(markdown).draft;
    if (options.excludeDrafts && (draft === true || draft === "true")) continue;
    const notePath = toPosix(path.relative(contentRoot, noteFile));
    publishedNotes.push(notePath);
    for (const target of extractMediaTargets(markdown)) {
      const resolved = await resolveMediaTarget(
        contentRoot,
        noteFile,
        target,
        basenameIndex,
      );
      referencesByFile.set(resolved, [
        ...(referencesByFile.get(resolved) ?? []),
        { notePath, target },
      ]);
    }
  }

  const entries = await mapConcurrent(
    [...referencesByFile.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    options.uploadConcurrency,
    async ([filePath, references]): Promise<MediaManifestEntry> => {
      const type = mediaTypeForTarget(filePath);
      if (!type) throw new Error(`Unsupported media file: ${filePath}`);
      const [fileStat, sha256] = await Promise.all([
        stat(filePath),
        sha256File(filePath),
      ]);
      const sourcePath = toPosix(path.relative(contentRoot, filePath));
      const key = contentAddressedKey(filePath, sha256, options);
      const entry: MediaManifestEntry = {
        sourcePath,
        outputPath: slugifyFilePath(sourcePath as FilePath) as string,
        kind: type.kind,
        mimeType: type.mimeType,
        byteSize: fileStat.size,
        sha256,
        key,
        publicUrl: originalUrlForKey(key, options),
        references,
      };
      if (type.kind === "image") {
        const metadata = await sharp(filePath).metadata();
        if (metadata.width) entry.width = metadata.width;
        if (metadata.height) entry.height = metadata.height;
      }
      return entry;
    },
  );
  return {
    version: 3,
    generatedAt: new Date().toISOString(),
    backend: options.backend,
    entries,
    publishedNotes: publishedNotes.sort(),
  };
}

export function manifestPath(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): string {
  return path.resolve(root, options.cacheDirectory, options.manifestFilename);
}

export async function writeManifest(
  manifest: MediaManifest,
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<string> {
  const destination = manifestPath(root, options);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

export async function readManifest(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<MediaManifest> {
  return JSON.parse(
    await readFile(manifestPath(root, options), "utf8"),
  ) as MediaManifest;
}
