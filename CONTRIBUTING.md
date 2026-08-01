# Developing Couplet

```sh
npm install
npm run build      # bundle the extension with esbuild
npm run watch      # rebuild on change
npm run typecheck
npm test           # node:test; most modules run without a vscode host
npm run package    # produces couplet-<version>.vsix via vsce
```

Press `F5` to launch an Extension Development Host for anything that needs the
real `vscode` API — webview rendering, `WorkspaceEdit`, and live streaming
against a deployment.

## Notes

- Bump `version` in `package.json` before packaging a build you intend to
  install. VS Code and Cursor cache extension assets by version, so reinstalling
  the same version over itself silently keeps the old icon and webview files.
- Modules that import `vscode` can't be unit tested under plain `node --test`.
  Where logic needs coverage, it's split into a `vscode`-free module next to the
  one that imports it (`aicore/sse.ts` vs `aicore/client.ts`, `agent/toolResults.ts`
  vs `agent/loop.ts`).
- `.vscodeignore` controls what ships in the `.vsix`. Check the file list vsce
  prints when packaging — `.couplet/` (session transcripts and checkpoints
  containing file contents) has leaked in before.
