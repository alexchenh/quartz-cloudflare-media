import { readFileSync } from "node:fs";
import path from "node:path";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { QuartzTransformerPlugin } from "@quartz-community/types";
import { visit } from "unist-util-visit";
import { isRemoteMediaBuild, resolveOptions } from "./config.js";
import { imageSrcSet, imageUrl, manifestPath } from "./core.js";
import type {
  CloudflareMediaOptions,
  MediaManifest,
  MediaManifestEntry,
  ResolvedCloudflareMediaOptions,
} from "./types.js";

export * from "./config.js";
export * from "./core.js";
export type * from "./types.js";

const normalized = (value: string): string => {
  let decoded = value.replace(/[?#].*$/, "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* preserve malformed authored URLs */
  }
  return path.posix
    .normalize(decoded.replace(/^\.\//, ""))
    .replace(/^\.\.\//g, "")
    .toLowerCase();
};

function entriesForNote(
  manifest: MediaManifest,
  notePath: string,
): MediaManifestEntry[] {
  return manifest.entries.filter((entry) =>
    entry.references.some((reference) => reference.notePath === notePath),
  );
}

function findEntry(
  entries: MediaManifestEntry[],
  notePath: string,
  source: string,
): MediaManifestEntry | undefined {
  const sourceNormalized = normalized(source);
  const fromNote = normalized(
    path.posix.join(path.posix.dirname(notePath), sourceNormalized),
  );
  const exact = entries.find((entry) => {
    const aliases = [entry.sourcePath, entry.outputPath];
    for (const reference of entry.references)
      if (reference.notePath === notePath) aliases.push(reference.target);
    return aliases.some((alias) =>
      [sourceNormalized, fromNote].includes(normalized(alias)),
    );
  });
  if (exact) return exact;
  const basename = path.posix.basename(sourceNormalized);
  const matches = entries.filter(
    (entry) => path.posix.basename(normalized(entry.sourcePath)) === basename,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

const classNames = (node: Element): string[] => {
  const value = node.properties.className;
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
};

type ElementParent = Root | Element;

export function rewriteMediaTree(
  tree: Root,
  notePath: string,
  manifest: MediaManifest,
  options: ResolvedCloudflareMediaOptions,
): void {
  const entries = entriesForNote(manifest, notePath);
  if (entries.length === 0) return;
  const imagesToWrap: Array<{
    node: Element;
    parent: ElementParent;
    index: number;
    entry: MediaManifestEntry;
  }> = [];
  const videos: Array<{
    node: Element;
    parent?: ElementParent;
    index?: number;
  }> = [];
  const videoUrls = new Map<Element, string>();

  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName === "img" && typeof node.properties.src === "string") {
      const entry = findEntry(entries, notePath, node.properties.src);
      if (!entry || entry.kind !== "image") return;
      node.properties.src = imageUrl(
        entry.publicUrl,
        options.defaultImageWidth,
        options,
      );
      node.properties.srcSet = imageSrcSet(entry.publicUrl, options);
      node.properties.sizes ??= options.imageSizes;
      node.properties["data-cloudflare-media"] = "image";
      if (
        entry.width &&
        entry.height &&
        !node.properties.width &&
        !node.properties.height
      ) {
        node.properties.width = entry.width;
        node.properties.height = entry.height;
      }
      if (parent?.type === "element" && parent.tagName === "a") {
        if (
          typeof parent.properties.href === "string" &&
          findEntry(entries, notePath, parent.properties.href) === entry
        ) {
          parent.properties.href = entry.publicUrl;
        }
      } else if (parent && typeof index === "number") {
        imagesToWrap.push({
          node,
          parent: parent as ElementParent,
          index,
          entry,
        });
      }
      return;
    }
    if (node.tagName === "video") {
      if (parent && typeof index === "number")
        videos.push({ node, parent: parent as ElementParent, index });
      if (typeof node.properties.src === "string") {
        const entry = findEntry(entries, notePath, node.properties.src);
        if (entry?.kind === "video") {
          node.properties.src = entry.publicUrl;
          node.properties["data-cloudflare-media"] = "video";
          videoUrls.set(node, entry.publicUrl);
        }
      }
      return;
    }
    if (node.tagName === "source" && typeof node.properties.src === "string") {
      const entry = findEntry(entries, notePath, node.properties.src);
      if (!entry || entry.kind !== "video") return;
      node.properties.src = entry.publicUrl;
      node.properties.type ??= entry.mimeType;
      node.properties["data-cloudflare-media"] = "video-source";
      if (parent?.type === "element" && parent.tagName === "video")
        videoUrls.set(parent, entry.publicUrl);
    }
  });

  for (const { node, parent, index, entry } of imagesToWrap) {
    const alt =
      typeof node.properties.alt === "string" ? node.properties.alt.trim() : "";
    const anchor: Element = {
      type: "element",
      tagName: "a",
      properties: {
        href: entry.publicUrl,
        target: "_blank",
        rel: ["noopener", "noreferrer"],
        ariaLabel: alt
          ? `Open full-size image: ${alt}`
          : "Open full-size image",
        className: ["cloudflare-media-original"],
      },
      children: [node],
    };
    parent.children[index] = anchor as RootContent & ElementContent;
  }
  for (const { node, parent, index } of [...videos].reverse()) {
    const publicUrl = videoUrls.get(node);
    if (!publicUrl) continue;
    node.properties.preload ??= "metadata";
    node.properties.playsInline ??= true;
    node.properties.className = [...classNames(node), "cloudflare-media-video"];
    if (!parent || typeof index !== "number") continue;
    if (
      parent.children.some(
        (child) =>
          child.type === "element" &&
          child.tagName === "a" &&
          classNames(child).includes("cloudflare-media-video-link"),
      )
    )
      continue;
    const fallback: Element = {
      type: "element",
      tagName: "a",
      properties: {
        href: publicUrl,
        target: "_blank",
        rel: ["noopener", "noreferrer"],
        className: ["cloudflare-media-video-link"],
      },
      children: [{ type: "text", value: "Open video file" }],
    };
    parent.children.splice(
      index + 1,
      0,
      { type: "text", value: " " },
      fallback,
    );
  }
}

export const cloudflareMediaStyles = `
img[data-cloudflare-media="image"],
video.cloudflare-media-video { max-width: 100%; height: auto; }
.cloudflare-media-video-link { display: inline-block; margin-top: 0.35rem; font-size: 0.875em; }
`;

export const CloudflareMedia: QuartzTransformerPlugin<
  CloudflareMediaOptions
> = (input) => {
  if (!input) throw new Error("CloudflareMedia requires configuration options");
  const options = resolveOptions(input);
  const remote = isRemoteMediaBuild();
  let manifest: MediaManifest | undefined;
  if (remote) {
    const filename = manifestPath(process.cwd(), options);
    try {
      manifest = JSON.parse(readFileSync(filename, "utf8")) as MediaManifest;
    } catch (error) {
      throw new Error(
        `Cloudflare media manifest is unavailable at ${filename}. Run quartz-cloudflare-media sync first. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    name: "CloudflareMedia",
    htmlPlugins() {
      if (!remote || !manifest) return [];
      return [
        () => (tree: Root, file) =>
          rewriteMediaTree(
            tree,
            String(file.data.relativePath ?? ""),
            manifest!,
            options,
          ),
      ];
    },
    externalResources() {
      return remote
        ? { css: [{ inline: true, content: cloudflareMediaStyles }] }
        : undefined;
    },
  };
};

export default CloudflareMedia;
