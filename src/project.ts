import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { resolveOptions } from "./config.js";
import type {
  CloudflareMediaOptions,
  ResolvedCloudflareMediaOptions,
} from "./types.js";

export const PACKAGE_NAME = "@alexchenh/quartz-cloudflare-media";
export const RECEIPT_FILE = ".quartz-cache/cloudflare-media-install.json";

interface QuartzPluginEntry {
  source?: string | { name?: string; repo?: string };
  enabled?: boolean;
  order?: number;
  options?: Record<string, unknown>;
}

interface QuartzYaml {
  configuration?: { ignorePatterns?: string[] };
  plugins?: QuartzPluginEntry[];
}

export interface ChangedFileReceipt {
  path: string;
  before: string | null;
  afterSha256: string;
}

export interface InstallReceipt {
  version: 1;
  createdAt: string;
  files: ChangedFileReceipt[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

async function optionalRead(filename: string): Promise<string | null> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function findQuartzRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      await access(path.join(current, "quartz.config.yaml"));
      await access(path.join(current, "package.json"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current)
        throw new Error(
          "Could not find a Quartz root containing quartz.config.yaml and package.json",
        );
      current = parent;
    }
  }
}

export async function loadProjectOptions(
  root = process.cwd(),
): Promise<ResolvedCloudflareMediaOptions> {
  const source = await readFile(path.join(root, "quartz.config.yaml"), "utf8");
  const parsed = YAML.parse(source) as QuartzYaml;
  const entry = parsed.plugins?.find((plugin) => {
    const pluginSource =
      typeof plugin.source === "string"
        ? plugin.source
        : (plugin.source?.name ?? plugin.source?.repo);
    return (
      pluginSource === PACKAGE_NAME ||
      pluginSource?.includes("quartz-cloudflare-media")
    );
  });
  if (!entry?.options)
    throw new Error(`No ${PACKAGE_NAME} options found in quartz.config.yaml`);
  return resolveOptions(entry.options as unknown as CloudflareMediaOptions);
}

export function buildProjectEdits(
  root: string,
  packageSource: string,
  quartzSource: string,
  options: CloudflareMediaOptions,
): Map<string, string> {
  const pkg = JSON.parse(packageSource) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [PACKAGE_NAME]: "^1.0.0" };
  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    "media:prepare": "quartz-cloudflare-media prepare",
    "media:sync": "quartz-cloudflare-media sync",
    "media:finalize": "quartz-cloudflare-media finalize",
    "media:check": "quartz-cloudflare-media check",
    "media:doctor": "quartz-cloudflare-media doctor",
    "media:prune:dry-run": "quartz-cloudflare-media prune --dry-run",
    "build:media":
      "npm run media:sync && CLOUDFLARE_MEDIA_MODE=remote npx quartz build && npm run media:finalize && npm run media:check",
  };

  const yaml = YAML.parse(quartzSource) as QuartzYaml;
  yaml.plugins ??= [];
  const prior = yaml.plugins.find((entry) => {
    const source =
      typeof entry.source === "string"
        ? entry.source
        : (entry.source?.name ?? entry.source?.repo);
    return source === PACKAGE_NAME || source?.includes("cloudflare-media");
  });
  const plugin: QuartzPluginEntry = prior ?? { source: PACKAGE_NAME };
  plugin.source = PACKAGE_NAME;
  plugin.enabled = true;
  plugin.order = 65;
  plugin.options = options as unknown as Record<string, unknown>;
  if (!prior) {
    const crawlIndex = yaml.plugins.findIndex((entry) =>
      (typeof entry.source === "string"
        ? entry.source
        : entry.source?.name
      )?.includes("crawl-links"),
    );
    yaml.plugins.splice(
      crawlIndex < 0 ? yaml.plugins.length : crawlIndex + 1,
      0,
      plugin,
    );
  }

  const gitignorePath = path.join(root, ".gitignore");
  const edits = new Map<string, string>([
    [path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`],
    [
      path.join(root, "quartz.config.yaml"),
      YAML.stringify(yaml, { lineWidth: 100 }),
    ],
  ]);
  edits.set(gitignorePath, "");
  return edits;
}

export async function applyProjectEdits(
  root: string,
  edits: Map<string, string>,
): Promise<InstallReceipt> {
  const receipt: InstallReceipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    files: [],
  };
  for (const [filename, proposed] of edits) {
    const before = await optionalRead(filename);
    let after = proposed;
    if (path.basename(filename) === ".gitignore") {
      const lines = new Set((before ?? "").split(/\r?\n/).filter(Boolean));
      lines.add(".quartz-cache/");
      lines.add(".env*");
      lines.add(".dev.vars*");
      after = `${[...lines].join("\n")}\n`;
    }
    if (before === after) continue;
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, after, { mode: 0o600 });
    await rename(temporary, filename);
    receipt.files.push({
      path: path.relative(root, filename),
      before,
      afterSha256: sha256(after),
    });
  }
  const receiptPath = path.join(root, RECEIPT_FILE);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return receipt;
}

export async function undoProjectEdits(root: string): Promise<string[]> {
  const receipt = JSON.parse(
    await readFile(path.join(root, RECEIPT_FILE), "utf8"),
  ) as InstallReceipt;
  const restored: string[] = [];
  for (const file of receipt.files) {
    const filename = path.join(root, file.path);
    const current = await optionalRead(filename);
    if (current === null || sha256(current) !== file.afterSha256) {
      throw new Error(
        `Refusing to restore ${file.path}: it changed after init`,
      );
    }
    if (file.before === null) {
      const { unlink } = await import("node:fs/promises");
      await unlink(filename);
    } else {
      await writeFile(filename, file.before);
    }
    restored.push(file.path);
  }
  return restored;
}

export async function projectDefaults(
  root: string,
  backend: "worker" | "direct-r2",
  publicOrigin: string,
  bucketName?: string,
): Promise<CloudflareMediaOptions> {
  const parsed = YAML.parse(
    await readFile(path.join(root, "quartz.config.yaml"), "utf8"),
  ) as QuartzYaml;
  return {
    backend,
    publicOrigin,
    imageTransformOrigin: publicOrigin,
    bucketName,
    contentDirectory: "content",
    outputDirectory: "public",
    cacheDirectory: ".quartz-cache",
    ignorePatterns: parsed.configuration?.ignorePatterns ?? [
      "private",
      "templates",
      ".obsidian",
    ],
    excludeDrafts: true,
    imageWidths: [640, 1280, 1920],
    defaultImageWidth: 1280,
    imageQuality: 88,
    imageSizes: "(max-width: 800px) 100vw, 800px",
    uploadConcurrency: 4,
    multipartConcurrency: 2,
    multipartPartSize: 95 * 1024 * 1024,
  };
}
