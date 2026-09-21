import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const safe = (s) =>
  s
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
export async function generateMarkdownArtifacts({ plugins = [] } = {}) {
  const options = {
    absWorkingDir: root,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
    metafile: true,
    plugins,
  };
  const core = await build({
    ...options,
    entryPoints: ["src/markdown/workspace.js"],
    globalName: "mdCore",
  });
  const bounds = await build({
    ...options,
    entryPoints: ["src/markdown/limits.js"],
    globalName: "mdBounds",
  });
  const worker = await build({
    ...options,
    conditions: ["worker"],
    entryPoints: ["src/markdown/worker.js"],
  });
  const packages = new Set();
  for (const output of [core, worker])
    for (const input of Object.keys(output.metafile.inputs))
      if (input.startsWith("node_modules/")) {
        const parts = input.split("/");
        packages.add(
          parts[1].startsWith("@") ? parts.slice(1, 3).join("/") : parts[1],
        );
      }
  const notices = [];
  for (const name of [...packages].sort()) {
    const dir = path.join(root, "node_modules", name),
      meta = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    let license;
    for (const file of ["license", "LICENSE", "LICENSE.md", "LICENSE.txt"])
      try {
        license = await readFile(path.join(dir, file), "utf8");
        break;
      } catch {}
    if (!license) throw new Error("Missing license for " + name);
    notices.push(name + "@" + meta.version + "\n\n" + license);
  }
  const licenses = notices.join("\n\n--------------------\n\n");
  const region =
    '<!-- MD GENERATED START -->\n<script id="markdown-core">\nconst markdownWorkspace=(()=>{' +
    core.outputFiles[0].text +
    "return Object.freeze({...mdCore});})();\nconst markdownBounds=(()=>{" +
    bounds.outputFiles[0].text +
    'return Object.freeze({...mdBounds});})();\n</script>\n<script id="markdown-worker" type="application/json">' +
    safe(JSON.stringify(worker.outputFiles[0].text)) +
    '</script>\n<script id="markdown-licenses" type="text/plain">' +
    licenses.replace(/<\/script/gi, "<\\/script") +
    "</script>\n<!-- MD GENERATED END -->";
  return { region, licenses };
}
export function replaceMarkdownRegion(html, region) {
  const starts = html.match(/<!-- MD GENERATED START -->/g) || [],
    ends = html.match(/<!-- MD GENERATED END -->/g) || [];
  if (
    starts.length !== ends.length ||
    starts.length > 1 ||
    (starts.length &&
      !/<!-- MD GENERATED START -->[\s\S]*?<!-- MD GENERATED END -->/.test(
        html,
      ))
  )
    throw new Error("Invalid Markdown generated boundaries");
  if (starts.length)
    return html.replace(
      /<!-- MD GENERATED START -->[\s\S]*?<!-- MD GENERATED END -->/,
      () => region,
    );
  const marker = "<script>\n(() => {";
  if (html.split(marker).length !== 2)
    throw new Error("Application boundary missing");
  return html.replace(marker, () => region + "\n" + marker);
}
async function main() {
  const html = await readFile(path.join(root, "index.html"), "utf8"),
    { region, licenses } = await generateMarkdownArtifacts(),
    result = replaceMarkdownRegion(html, region);
  const licensePath = path.join(root, "LICENSES/markdown-dependencies.txt");
  if (process.argv.includes("--check")) {
    if (result !== html || (await readFile(licensePath, "utf8")) !== licenses)
      throw new Error("Markdown artifacts are stale");
  } else {
    await writeFile(path.join(root, "index.html"), result);
    await writeFile(licensePath, licenses);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
