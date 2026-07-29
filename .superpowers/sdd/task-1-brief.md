### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `.gitignore`, `.vscode/launch.json`

**Interfaces:**
- Produces: npm scripts `build`, `watch`, `test`, `package`; the `forge.*` configuration keys later tasks read via `vscode.workspace.getConfiguration("forge")`.

- [ ] **Step 1: Init git and npm**

```bash
cd /Users/rahulsharma/Developer/Forge
git init
npm init -y
npm install --save ignore
npm install --save-dev typescript @types/node @types/vscode esbuild @vscode/vsce
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist-check",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `esbuild.mjs`**

```js
import * as esbuild from "esbuild";

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

if (watch) {
  await ctx.watch();
  console.log("watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
```

- [ ] **Step 4: Write `package.json` scripts and `contributes` block**

```jsonc
{
  "name": "forge",
  "displayName": "Forge",
  "publisher": "internal",
  "version": "0.0.1",
  "private": true,
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "activationEvents": [],
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test src/**/*.test.ts",
    "package": "vsce package"
  },
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "forge", "title": "Forge", "icon": "media/icon.svg" }]
    },
    "views": {
      "forge": [{ "type": "webview", "id": "forge.chat", "name": "Chat" }]
    },
    "commands": [
      { "command": "forge.newSession", "title": "Forge: New Session" },
      { "command": "forge.ping", "title": "Forge: Ping (debug)" }
    ],
    "configuration": {
      "properties": {
        "forge.serviceKeyPath": { "type": "string", "default": "" },
        "forge.deploymentId": { "type": "string", "default": "" },
        "forge.resourceGroup": { "type": "string", "default": "default" },
        "forge.apiVersion": { "type": "string", "default": "2024-10-21" },
        "forge.model": { "type": "string", "default": "" },
        "forge.approvalMode": { "type": "string", "enum": ["ask", "auto"], "default": "ask" },
        "forge.contextBudget": { "type": "number", "default": 100000 }
      }
    }
  },
  "dependencies": { "ignore": "^5.3.0" }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
dist-check/
*.vsix
```

- [ ] **Step 6: Write `media/icon.svg`** (any simple placeholder square SVG is fine — VS Code just needs a valid file at that path)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="currentColor"/></svg>
```

- [ ] **Step 7: Verify scaffolding compiles**

Run: `npx tsc --noEmit`
Expected: no errors (no `.ts` files yet, so this is a no-op success — just confirms `tsconfig.json` is valid).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json esbuild.mjs .gitignore media/icon.svg package-lock.json
git commit -m "chore: scaffold Forge extension project"
```

---

