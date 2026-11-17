import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Next may report a failed traced-file copy as a warning. Never ship that image.
const root = process.cwd();
const dist = path.resolve(process.env.NEXT_DIST_DIR || ".next-build");
const standalone = path.join(dist, "standalone");
async function traces(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? traces(file)
        : entry.name.endsWith(".nft.json")
          ? [file]
          : [];
    }),
  );
  return nested.flat();
}
if (!existsSync(path.join(standalone, "server.js")))
  throw new Error("Missing standalone server.");
const manifests = [
  path.join(dist, "next-server.js.nft.json"),
  ...(await traces(path.join(dist, "server"))),
];
const missing = new Set();
for (const manifest of manifests) {
  const { files } = JSON.parse(await readFile(manifest, "utf8"));
  for (const file of files) {
    const relative = path.relative(
      root,
      path.resolve(path.dirname(manifest), file),
    );
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Build trace escaped the project.");
    if (!existsSync(path.join(standalone, relative))) missing.add(relative);
  }
}
if (missing.size)
  throw new Error(
    `Incomplete standalone build: ${missing.size} missing files.`,
  );
console.log(`Standalone build checked (${manifests.length} trace manifests).`);
