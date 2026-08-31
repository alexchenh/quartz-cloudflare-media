#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import YAML from "yaml";
import { check, finalize, prepare, pruneDryRun, sync } from "./pipeline.js";
import {
  PACKAGE_NAME,
  RECEIPT_FILE,
  applyProjectEdits,
  buildProjectEdits,
  findQuartzRoot,
  loadProjectOptions,
  projectDefaults,
  undoProjectEdits,
  type InstallReceipt,
} from "./project.js";
import type { CloudflareMediaOptions } from "./types.js";

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument?.startsWith("--"))
      throw new Error(`Unexpected argument ${argument}`);
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (!rawName) throw new Error("Invalid empty flag");
    if (inlineValue !== undefined) flags.set(rawName, inlineValue);
    else if (rest[index + 1] && !rest[index + 1]!.startsWith("--"))
      flags.set(rawName, rest[++index]!);
    else flags.set(rawName, true);
  }
  return { command, flags };
}

const stringFlag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};
const boolFlag = (args: ParsedArgs, name: string): boolean =>
  args.flags.get(name) === true;

function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; quiet?: boolean } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    stdio: options.quiet
      ? ["pipe", "pipe", "pipe"]
      : [options.input ? "pipe" : "inherit", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
  if (!options.quiet) {
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.stdout ?? "";
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!stdin.isTTY) throw new Error("Confirmation required; rerun with --yes");
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return /^y(?:es)?$/i.test(
      (await prompt.question(`${question} [y/N] `)).trim(),
    );
  } finally {
    prompt.close();
  }
}

async function ask(question: string, fallback?: string): Promise<string> {
  if (!stdin.isTTY)
    throw new Error(`${question} is required in noninteractive mode`);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await prompt.question(`${question}${fallback ? ` (${fallback})` : ""}: `)
    ).trim();
    return answer || fallback || "";
  } finally {
    prompt.close();
  }
}

function packageRoot(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(current) === "dist" || path.basename(current) === "src"
    ? path.dirname(current)
    : current;
}

async function deployWorker(
  args: ParsedArgs,
  rootName: string,
): Promise<{ origin: string; bucketName: string }> {
  const workerName = stringFlag(args, "worker-name") ?? `${rootName}-media`;
  const bucketName = stringFlag(args, "bucket") ?? `${rootName}-media`;
  run("wrangler", ["whoami"], { quiet: true });
  const listOutput = run("wrangler", ["r2", "bucket", "list", "--json"], {
    quiet: true,
  });
  const buckets = JSON.parse(listOutput) as Array<{ name?: string }>;
  if (!buckets.some((bucket) => bucket.name === bucketName)) {
    run("wrangler", ["r2", "bucket", "create", bucketName]);
  }

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "quartz-cloudflare-media-worker-"),
  );
  try {
    await cp(
      path.join(packageRoot(), "worker", "src"),
      path.join(temporary, "src"),
      { recursive: true },
    );
    const customDomain = stringFlag(args, "custom-domain");
    const config = {
      name: workerName,
      main: "src/index.ts",
      compatibility_date: "2026-08-31",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      ...(customDomain
        ? { routes: [{ pattern: customDomain, custom_domain: true }] }
        : {}),
      r2_buckets: [{ binding: "MEDIA", bucket_name: bucketName }],
      images: { binding: "IMAGES" },
      vars: { IMAGE_WIDTHS: "640,1280,1920", IMAGE_QUALITY: "88" },
      secrets: { required: ["UPLOAD_TOKEN"] },
      observability: {
        enabled: true,
        logs: { head_sampling_rate: 1 },
        traces: { enabled: true, head_sampling_rate: 0.01 },
      },
    };
    const configPath = path.join(temporary, "wrangler.jsonc");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const deployOutput = run("wrangler", [
      "deploy",
      "--config",
      configPath,
      "--keep-vars",
    ]);
    const token = randomBytes(32).toString("base64url");
    run("wrangler", ["secret", "put", "UPLOAD_TOKEN", "--config", configPath], {
      input: `${token}\n`,
      quiet: true,
    });
    const pagesProject = stringFlag(args, "pages-project");
    if (pagesProject) {
      run(
        "wrangler",
        [
          "pages",
          "secret",
          "put",
          "CLOUDFLARE_MEDIA_UPLOAD_TOKEN",
          "--project-name",
          pagesProject,
        ],
        { input: `${token}\n`, quiet: true },
      );
    } else {
      console.log(
        "Set CLOUDFLARE_MEDIA_UPLOAD_TOKEN to the generated Worker secret in your build environment.",
      );
      console.log(
        "The secret was not printed or stored locally; rerun configure-ci to rotate and connect it.",
      );
    }
    const origin =
      stringFlag(args, "origin") ??
      (customDomain
        ? `https://${customDomain}`
        : deployOutput.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0]);
    if (!origin)
      throw new Error("Could not determine the Worker URL; pass --origin");
    process.env.CLOUDFLARE_MEDIA_UPLOAD_TOKEN = token;
    await smokeWorker(origin, token);
    return { origin, bucketName };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function smokeWorker(origin: string, token: string): Promise<void> {
  const fixture = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const hash = createHash("sha256").update(fixture).digest("hex");
  const key = `v1/${hash}/setup-check.png`;
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  const headers = { authorization: `Bearer ${token}` };
  try {
    const upload = await fetch(`${origin}/v1/upload/${encoded}`, {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "image/png",
        "x-content-sha256": hash,
      },
      body: fixture,
    });
    if (!upload.ok) throw new Error(`fixture upload returned ${upload.status}`);
    const original = await fetch(`${origin}/v1/original/${encoded}`);
    if (!original.ok)
      throw new Error(`fixture fetch returned ${original.status}`);
    const transformed = await fetch(`${origin}/v1/image/640/${encoded}`, {
      headers: { accept: "image/webp" },
    });
    if (!transformed.ok)
      throw new Error(`fixture transformation returned ${transformed.status}`);
  } finally {
    await fetch(`${origin}/v1/upload/${encoded}`, {
      method: "DELETE",
      headers,
    });
  }
}

function displayEdits(root: string, edits: Map<string, string>): void {
  console.log("Planned changes:");
  for (const filename of edits.keys())
    console.log(`  ${path.relative(root, filename)}`);
}

async function appendLockReceipt(
  root: string,
  before: string | null,
): Promise<void> {
  const lockPath = path.join(root, "package-lock.json");
  let after: string;
  try {
    after = await readFile(lockPath, "utf8");
  } catch {
    return;
  }
  if (before === after) return;
  const receiptPath = path.join(root, RECEIPT_FILE);
  const receipt = JSON.parse(
    await readFile(receiptPath, "utf8"),
  ) as InstallReceipt;
  receipt.files.push({
    path: "package-lock.json",
    before,
    afterSha256: createHash("sha256").update(after).digest("hex"),
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function init(args: ParsedArgs): Promise<void> {
  const root = await findQuartzRoot(stringFlag(args, "root"));
  const pkgSource = await readFile(path.join(root, "package.json"), "utf8");
  const quartzSource = await readFile(
    path.join(root, "quartz.config.yaml"),
    "utf8",
  );
  const pkg = JSON.parse(pkgSource) as {
    engines?: { node?: string };
    version?: string;
  };
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node 22 or newer is required");
  if (!quartzSource.includes("plugins:"))
    throw new Error(
      "quartz.config.yaml does not contain a Quartz 5 plugins list",
    );

  const backendValue =
    stringFlag(args, "backend") ??
    (stdin.isTTY
      ? await ask("Backend: worker or direct-r2", "worker")
      : "worker");
  if (backendValue !== "worker" && backendValue !== "direct-r2")
    throw new Error("--backend must be worker or direct-r2");
  let origin = stringFlag(args, "origin");
  let bucketName = stringFlag(args, "bucket");
  if (backendValue === "worker" && !origin && !boolFlag(args, "dry-run")) {
    const deployment = await deployWorker(
      args,
      path
        .basename(root)
        .replace(/[^a-z0-9-]/gi, "-")
        .toLowerCase(),
    );
    origin = deployment.origin;
    bucketName = deployment.bucketName;
  }
  if (!origin)
    origin =
      backendValue === "worker"
        ? "https://your-worker.workers.dev"
        : await ask("Public media origin");
  if (backendValue === "direct-r2" && !bucketName)
    bucketName = await ask("R2 bucket name");
  const options = await projectDefaults(root, backendValue, origin, bucketName);
  const transformOrigin = stringFlag(args, "image-transform-origin");
  if (transformOrigin) options.imageTransformOrigin = transformOrigin;

  const edits = buildProjectEdits(root, pkgSource, quartzSource, options);
  displayEdits(root, edits);
  if (boolFlag(args, "dry-run")) {
    if (boolFlag(args, "json"))
      console.log(
        JSON.stringify({
          root,
          options,
          files: [...edits.keys()].map((file) => path.relative(root, file)),
        }),
      );
    return;
  }
  if (!(await confirm("Apply these changes?", boolFlag(args, "yes")))) return;
  let lockBefore: string | null = null;
  try {
    lockBefore = await readFile(path.join(root, "package-lock.json"), "utf8");
  } catch {
    /* optional */
  }
  await applyProjectEdits(root, edits);
  run("npm", ["install"], { cwd: root });
  await appendLockReceipt(root, lockBefore);
  const resolved = await loadProjectOptions(root);
  await prepare(root, resolved);
  if (!boolFlag(args, "skip-build"))
    run("node", ["quartz/bootstrap-cli.mjs", "build"], { cwd: root });
  await doctor(root, resolved);
  console.log(
    `Installed ${PACKAGE_NAME}. Use npm run build:media for a remote media build.`,
  );
  void pkg;
}

async function doctor(
  root: string,
  providedOptions?: Awaited<ReturnType<typeof loadProjectOptions>>,
): Promise<void> {
  const options = providedOptions ?? (await loadProjectOptions(root));
  const failures: string[] = [];
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  if (!pkg.dependencies?.[PACKAGE_NAME])
    failures.push(`${PACKAGE_NAME} is not in dependencies`);
  for (const script of [
    "media:sync",
    "media:finalize",
    "media:check",
    "build:media",
  ])
    if (!pkg.scripts?.[script]) failures.push(`missing npm script ${script}`);
  if (options.backend === "direct-r2") {
    for (const variable of [
      "CLOUDFLARE_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ])
      if (!process.env[variable])
        failures.push(`missing environment variable ${variable}`);
  } else if (!process.env[options.workerUploadTokenEnvironment]) {
    failures.push(
      `missing environment variable ${options.workerUploadTokenEnvironment}`,
    );
  }
  try {
    const response = await fetch(options.publicOrigin, { method: "HEAD" });
    if (response.status >= 500)
      failures.push(`media origin returned ${response.status}`);
  } catch {
    failures.push("media origin is unreachable");
  }
  if (failures.length)
    throw new Error(
      `Doctor found ${failures.length} issue(s):\n- ${failures.join("\n- ")}`,
    );
  console.log(
    `Doctor passed for ${options.backend} at ${options.publicOrigin}.`,
  );
}

async function configureCi(args: ParsedArgs): Promise<void> {
  const root = await findQuartzRoot(stringFlag(args, "root"));
  const options = await loadProjectOptions(root);
  if (options.backend !== "worker")
    throw new Error("configure-ci is only used by the worker backend");
  const workerName =
    stringFlag(args, "worker-name") ?? (await ask("Worker name"));
  const pagesProject =
    stringFlag(args, "pages-project") ??
    (await ask("Cloudflare Pages project"));
  const token = randomBytes(32).toString("base64url");
  run("wrangler", ["secret", "put", "UPLOAD_TOKEN", "--name", workerName], {
    input: `${token}\n`,
    quiet: true,
  });
  run(
    "wrangler",
    [
      "pages",
      "secret",
      "put",
      options.workerUploadTokenEnvironment,
      "--project-name",
      pagesProject,
    ],
    { input: `${token}\n`, quiet: true },
  );
  console.log(
    "Rotated and connected the upload secret without writing it locally.",
  );
}

function help(): void {
  console.log(`quartz-cloudflare-media <command> [options]

Commands:
  init             Configure an existing Quartz 5 site
  doctor           Validate the local and remote integration
  prepare          Discover published media and write a manifest
  sync             Upload missing immutable objects
  finalize         Remove redundant media from Quartz output
  check            Validate generated HTML and output
  deploy-worker    Provision the Worker and R2 bucket
  configure-ci     Rotate and connect Worker/Pages upload secrets
  prune --dry-run  List unreferenced objects without deleting
  undo-init        Restore files that have not changed since init`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) return help();
  if (args.command === "init") return init(args);
  if (args.command === "deploy-worker") {
    const root = await findQuartzRoot(stringFlag(args, "root"));
    const deployed = await deployWorker(
      args,
      path
        .basename(root)
        .replace(/[^a-z0-9-]/gi, "-")
        .toLowerCase(),
    );
    console.log(YAML.stringify(deployed));
    return;
  }
  if (args.command === "configure-ci") return configureCi(args);
  const root = await findQuartzRoot(stringFlag(args, "root"));
  if (args.command === "undo-init") {
    const restored = await undoProjectEdits(root);
    console.log(
      `Restored ${restored.join(", ")}. Remote resources and media were untouched.`,
    );
    return;
  }
  const options = await loadProjectOptions(root);
  if (args.command === "doctor") return doctor(root, options);
  if (args.command === "prepare") {
    await prepare(root, options);
    return;
  }
  if (args.command === "sync") return sync(root, options);
  if (args.command === "finalize") return finalize(root, options);
  if (args.command === "check") return check(root, options);
  if (args.command === "prune" && boolFlag(args, "dry-run"))
    return pruneDryRun(root, options);
  throw new Error(
    `Unknown or unsafe command ${args.command}. Prune requires --dry-run.`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
