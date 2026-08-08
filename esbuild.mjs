import * as esbuild from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");

const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
});

// The headless CLI (used for CI and benchmark harnesses like Terminal-Bench
// and SWE-bench — see src/cli/main.ts) has no `external: ["vscode"]`: nothing
// on its import graph may reference the "vscode" module, so a stray
// dependency on it fails this build loudly instead of failing at runtime
// inside a container that has no such module.
const cliCtx = await esbuild.context({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  outfile: "dist/cli.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});

function copyWebviewAssets() {
  fs.mkdirSync("dist/webview", { recursive: true });
  for (const file of ["index.html", "style.css", "main.js"]) {
    fs.copyFileSync(`src/ui/webview/${file}`, `dist/webview/${file}`);
  }
}

if (watch) {
  await extensionCtx.watch();
  await cliCtx.watch();
  copyWebviewAssets();
  console.log("watching...");
} else {
  await extensionCtx.rebuild();
  await cliCtx.rebuild();
  copyWebviewAssets();
  await extensionCtx.dispose();
  await cliCtx.dispose();
}
