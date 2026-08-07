import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
await mkdir(path.join(root, "dist"), { recursive: true });

const options = {
  bundle: true,
  sourcemap: true,
  target: "es2020",
  logLevel: "info" as const,
};

if (watch) {
  const code = await context({
    ...options,
    entryPoints: [path.join(root, "src/code.ts")],
    outfile: path.join(root, "dist/code.js"),
  });
  const ui = await context({
    ...options,
    entryPoints: [path.join(root, "src/ui/main.ts")],
    outfile: path.join(root, "dist/ui.js"),
  });
  await code.watch();
  await ui.watch();
  await emitHtml();
  console.log("Watching Figma plugin sources…");
} else {
  await Promise.all([
    build({
      ...options,
      entryPoints: [path.join(root, "src/code.ts")],
      outfile: path.join(root, "dist/code.js"),
    }),
    build({
      ...options,
      entryPoints: [path.join(root, "src/ui/main.ts")],
      outfile: path.join(root, "dist/ui.js"),
    }),
  ]);
  await emitHtml();
}

async function emitHtml(): Promise<void> {
  const [template, script, styles] = await Promise.all([
    readFile(path.join(root, "src/ui/index.html"), "utf8"),
    readFile(path.join(root, "dist/ui.js"), "utf8"),
    readFile(path.join(root, "src/ui/styles.css"), "utf8"),
  ]);
  const html = template
    .replace("/* __STYLES__ */", styles)
    .replace("/* __SCRIPT__ */", script);
  await writeFile(path.join(root, "dist/ui.html"), html);
}
