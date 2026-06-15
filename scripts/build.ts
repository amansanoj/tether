/**
 * Build script using Bun's built-in bundler.
 *
 * When Vite and vite-plugin-solid are available (after `bun install`),
 * the build can be switched to use Vite for full Solid.js JSX support.
 * For now, this uses Bun's bundler to produce a working frontend bundle.
 */

import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const CLIENT_DIR = join(ROOT, "client");
const DIST_DIR = join(ROOT, "dist");

// Ensure dist directory exists
if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

// Bundle the client entry point
const result = await Bun.build({
  entrypoints: [join(CLIENT_DIR, "src/index.ts")],
  outdir: join(DIST_DIR, "assets"),
  target: "browser",
  minify: true,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy index.html to dist, injecting the script reference
const htmlSource = await Bun.file(join(CLIENT_DIR, "index.html")).text();

// Replace the module script src to point to the bundled output
const bundledFileName = result.outputs[0].path.split("/").pop();
const htmlOutput = htmlSource.replace(
  '<script type="module" src="/src/index.ts"></script>',
  `<script type="module" src="/assets/${bundledFileName}"></script>`
);

await Bun.write(join(DIST_DIR, "index.html"), htmlOutput);

console.log("Build complete:");
console.log(`  dist/index.html`);
console.log(`  dist/assets/${bundledFileName}`);
