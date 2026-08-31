import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { discoverManifest, readManifest, writeManifest } from "./core.js";
import { createTransport } from "./transports.js";
import type { MediaManifest, ResolvedCloudflareMediaOptions } from "./types.js";

const totalBytes = (manifest: MediaManifest): number =>
  manifest.entries.reduce((sum, entry) => sum + entry.byteSize, 0);
const formatBytes = (bytes: number): string =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    style: "unit",
    unit: "byte",
    unitDisplay: "narrow",
  }).format(bytes);

export async function prepare(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<MediaManifest> {
  const manifest = await discoverManifest(root, options);
  const destination = await writeManifest(manifest, root, options);
  const images = manifest.entries.filter(
    (entry) => entry.kind === "image",
  ).length;
  const videos = manifest.entries.filter(
    (entry) => entry.kind === "video",
  ).length;
  console.log(
    `Prepared ${images} images and ${videos} videos (${formatBytes(totalBytes(manifest))}) across ${manifest.publishedNotes.length} published notes.`,
  );
  console.log(`Manifest: ${path.relative(root, destination)}`);
  return manifest;
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const value = values[next++];
      if (value !== undefined) await callback(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
}

export async function sync(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<void> {
  const manifest = await prepare(root, options);
  const transport = createTransport(options);
  let uploaded = 0;
  let existing = 0;
  try {
    await mapConcurrent(
      manifest.entries,
      options.uploadConcurrency,
      async (entry) => {
        if (await transport.exists(entry)) existing++;
        else {
          await transport.upload(root, entry);
          uploaded++;
        }
      },
    );
  } finally {
    transport.close();
  }
  console.log(
    `Sync complete: ${uploaded} uploaded, ${existing} already present.`,
  );
}

const safeOutputPath = (
  root: string,
  relative: string,
  options: ResolvedCloudflareMediaOptions,
): string => {
  const outputRoot = path.resolve(root, options.outputDirectory);
  const destination = path.resolve(outputRoot, relative);
  if (!destination.startsWith(outputRoot + path.sep))
    throw new Error(`Refusing to operate outside ${outputRoot}`);
  return destination;
};

export async function finalize(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<void> {
  const manifest = await readManifest(root, options);
  let removed = 0;
  for (const entry of manifest.entries) {
    try {
      await unlink(safeOutputPath(root, entry.outputPath, options));
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  console.log(
    `Removed ${removed} redundant media files from the Quartz output.`,
  );
}

async function walkHtml(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkHtml(full)));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

export async function check(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<void> {
  const manifest = await readManifest(root, options);
  const htmlFiles = await walkHtml(path.resolve(root, options.outputDirectory));
  const html = (
    await Promise.all(htmlFiles.map((file) => readFile(file, "utf8")))
  ).join("\n");
  const failures: string[] = [];
  for (const entry of manifest.entries) {
    if (!html.includes(entry.publicUrl))
      failures.push(
        `${entry.sourcePath}: generated HTML is missing its media URL`,
      );
    try {
      await readFile(safeOutputPath(root, entry.outputPath, options));
      failures.push(`${entry.sourcePath}: redundant output copy remains`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (
    manifest.entries.some((entry) => entry.kind === "image") &&
    !html.includes('data-cloudflare-media="image"')
  )
    failures.push("no transformed images found");
  if (
    manifest.entries.some((entry) => entry.kind === "video") &&
    !html.includes("cloudflare-media-video-link")
  )
    failures.push("video fallback missing");
  if (failures.length)
    throw new Error(
      `Cloudflare media validation failed:\n- ${failures.join("\n- ")}`,
    );
  console.log(
    `Validated ${manifest.entries.length} media objects across ${htmlFiles.length} HTML files.`,
  );
}

export async function pruneDryRun(
  root: string,
  options: ResolvedCloudflareMediaOptions,
): Promise<void> {
  const manifest = await readManifest(root, options);
  const expected = new Set(manifest.entries.map((entry) => entry.key));
  const transport = createTransport(options);
  try {
    const orphaned = (await transport.list(`${options.keyPrefix}/`))
      .filter((key) => !expected.has(key))
      .sort();
    if (!orphaned.length) console.log("No unreferenced objects found.");
    else {
      console.log(`Dry run only: ${orphaned.length} unreferenced objects:`);
      for (const key of orphaned) console.log(key);
    }
  } finally {
    transport.close();
  }
}
