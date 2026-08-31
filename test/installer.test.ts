import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  PACKAGE_NAME,
  applyProjectEdits,
  buildProjectEdits,
  undoProjectEdits,
} from "../src/project.js";

test("installer edits are idempotent and undo only known content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quartz-media-installer-"));
  try {
    const packageSource = `${JSON.stringify({ name: "fixture", scripts: {}, dependencies: {} }, null, 2)}\n`;
    const quartzSource =
      "configuration:\n  ignorePatterns:\n    - private\nplugins:\n  - source: '@quartz-community/crawl-links'\n    enabled: true\n    order: 60\n";
    await mkdir(path.join(root, ".quartz-cache"), { recursive: true });
    await writeFile(path.join(root, "package.json"), packageSource);
    await writeFile(path.join(root, "quartz.config.yaml"), quartzSource);
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    const options = {
      backend: "worker" as const,
      publicOrigin: "https://media.example.workers.dev",
      ignorePatterns: ["private"],
    };
    const first = buildProjectEdits(root, packageSource, quartzSource, options);
    await applyProjectEdits(root, first);
    const packageAfter = await readFile(
      path.join(root, "package.json"),
      "utf8",
    );
    const yamlAfter = await readFile(
      path.join(root, "quartz.config.yaml"),
      "utf8",
    );
    assert.equal(JSON.parse(packageAfter).dependencies[PACKAGE_NAME], "^1.0.0");
    const parsed = YAML.parse(yamlAfter);
    assert.equal(
      parsed.plugins.filter(
        (entry: { source: string }) => entry.source === PACKAGE_NAME,
      ).length,
      1,
    );
    const second = buildProjectEdits(root, packageAfter, yamlAfter, options);
    await applyProjectEdits(root, second);
    assert.equal(
      YAML.parse(
        await readFile(path.join(root, "quartz.config.yaml"), "utf8"),
      ).plugins.filter(
        (entry: { source: string }) => entry.source === PACKAGE_NAME,
      ).length,
      1,
    );
    // Undo the second, no-op installation receipt should touch nothing.
    assert.deepEqual(await undoProjectEdits(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
