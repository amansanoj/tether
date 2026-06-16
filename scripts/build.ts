/**
 * Build script using Bun's built-in bundler.
 *
 * Produces a content-hashed JS bundle (e.g. index-a1b2c3d4.js) so that browsers
 * never serve a stale cached bundle after a rebuild. The hashed filename is
 * injected into dist/index.html automatically.
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const CLIENT_DIR = join(ROOT, "client");
const DIST_DIR = join(ROOT, "dist");
const ASSETS_DIR = join(DIST_DIR, "assets");

// Start from a clean assets directory so old hashed bundles don't pile up.
rmSync(ASSETS_DIR, { recursive: true, force: true });
mkdirSync(ASSETS_DIR, { recursive: true });

// Bundle the client entry point with a content hash in the filename.
const result = await Bun.build({
  entrypoints: [join(CLIENT_DIR, "src/index.ts")],
  outdir: ASSETS_DIR,
  target: "browser",
  minify: true,
  naming: "[name]-[hash].[ext]",
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy index.html to dist, injecting the (hashed) script reference.
const htmlSource = await Bun.file(join(CLIENT_DIR, "index.html")).text();

const bundledFileName = result.outputs[0].path.split("/").pop();
const htmlOutput = htmlSource.replace(
  '<script type="module" src="/src/index.ts"></script>',
  `<script type="module" src="/assets/${bundledFileName}"></script>`
);

await Bun.write(join(DIST_DIR, "index.html"), htmlOutput);

console.log("Build complete:");
console.log(`  dist/index.html`);
console.log(`  dist/assets/${bundledFileName}`);
