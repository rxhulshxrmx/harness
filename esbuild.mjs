import * as esbuild from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
});

function copyWebviewAssets() {
  fs.mkdirSync("dist/webview", { recursive: true });
  for (const file of ["index.html", "style.css", "main.js"]) {
    fs.copyFileSync(`src/ui/webview/${file}`, `dist/webview/${file}`);
  }
}

if (watch) {
  await ctx.watch();
  copyWebviewAssets();
  console.log("watching...");
} else {
  await ctx.rebuild();
  copyWebviewAssets();
  await ctx.dispose();
}
