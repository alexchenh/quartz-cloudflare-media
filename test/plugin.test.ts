import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Element, Root } from "hast";
import sharp from "sharp";
import {
  contentAddressedKey,
  discoverManifest,
  extractMediaTargets,
  imageUrl,
  resolveOptions,
  rewriteMediaTree,
  type MediaManifest,
} from "../src/index.js";

const direct = resolveOptions({
  backend: "direct-r2",
  bucketName: "garden-media",
  publicOrigin: "https://media.example.com",
  imageTransformOrigin: "https://media.example.com",
});
const worker = resolveOptions({
  backend: "worker",
  publicOrigin: "https://garden-media.example.workers.dev",
});

test("extracts Markdown, Obsidian, and HTML media but not code or external URLs", () => {
  const markdown = [
    "![](images/photo.jpg)",
    "![[clip.mov|A clip]]",
    '<video><source src="images/clip.webm"></video>',
    "![](https://example.com/external.jpg)",
    "```md\n![](images/ignored.png)\n```",
  ].join("\n");
  assert.deepEqual(extractMediaTargets(markdown), [
    "images/photo.jpg",
    "clip.mov",
    "images/clip.webm",
  ]);
});

test("generates stable direct and Worker URLs", () => {
  const hash = "a".repeat(64);
  const key = contentAddressedKey("My Favorite Photo.JPG", hash, direct);
  assert.equal(key, `v1/${hash}/my-favorite-photo.jpg`);
  const original = `https://media.example.com/${key}`;
  assert.match(
    imageUrl(original, 1280, direct),
    /\/cdn-cgi\/image\/width=1280,quality=88/,
  );
  const workerOriginal = `https://garden-media.example.workers.dev/v1/original/${key}`;
  assert.equal(
    imageUrl(workerOriginal, 1280, worker),
    `https://garden-media.example.workers.dev/v1/image/1280/${key}`,
  );
});

test("discovers published media and excludes ignored and draft notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quartz-media-test-"));
  try {
    await mkdir(path.join(root, "content", "images"), { recursive: true });
    await mkdir(path.join(root, "content", "private"), { recursive: true });
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#336699" },
    })
      .jpeg()
      .toFile(path.join(root, "content", "images", "Photo.JPG"));
    await writeFile(
      path.join(root, "content", "images", "clip.mov"),
      "video fixture",
    );
    await writeFile(
      path.join(root, "content", "Published.md"),
      "---\ntitle: Published\n---\n![](images/Photo.JPG)\n![](images/clip.mov)\n",
    );
    await writeFile(
      path.join(root, "content", "Draft.md"),
      "---\ndraft: true\n---\n![](images/Photo.JPG)\n",
    );
    await writeFile(
      path.join(root, "content", "private", "Secret.md"),
      "![](../images/Photo.JPG)\n",
    );
    const manifest = await discoverManifest(root, direct);
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.publishedNotes, ["Published.md"]);
    assert.equal(manifest.entries.length, 2);
    assert.equal(
      manifest.entries.find((entry) => entry.kind === "image")?.width,
      20,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewrites images and videos while preserving authored links", () => {
  const hash = "a".repeat(64);
  const publicUrl = `https://media.example.com/v1/${hash}/photo.jpg`;
  const manifest: MediaManifest = {
    version: 3,
    backend: "direct-r2",
    generatedAt: "2026-08-31T00:00:00.000Z",
    publishedNotes: ["Note.md"],
    entries: [
      {
        sourcePath: "images/photo.jpg",
        outputPath: "images/photo.jpg",
        kind: "image",
        mimeType: "image/jpeg",
        byteSize: 1,
        sha256: hash,
        key: `v1/${hash}/photo.jpg`,
        publicUrl,
        width: 2000,
        height: 1000,
        references: [{ notePath: "Note.md", target: "images/photo.jpg" }],
      },
    ],
  };
  const image: Element = {
    type: "element",
    tagName: "img",
    properties: { src: "./images/photo.jpg", alt: "Crowd" },
    children: [],
  };
  const link: Element = {
    type: "element",
    tagName: "a",
    properties: { href: "https://example.com" },
    children: [image],
  };
  const tree: Root = { type: "root", children: [link] };
  rewriteMediaTree(tree, "Note.md", manifest, direct);
  assert.equal(link.properties.href, "https://example.com");
  assert.match(String(image.properties.srcSet), /640w, .*1280w, .*1920w/);
  assert.equal(image.properties.width, 2000);
});

test("rejects unsafe or incomplete configuration", () => {
  assert.throws(
    () =>
      resolveOptions({
        backend: "direct-r2",
        publicOrigin: "https://media.example.com",
      }),
    /bucketName/,
  );
  assert.throws(
    () =>
      resolveOptions({ backend: "worker", publicOrigin: "http://example.com" }),
    /HTTPS/,
  );
});
