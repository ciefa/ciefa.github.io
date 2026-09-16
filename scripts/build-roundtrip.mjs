import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function generateRoundtripArtifacts({ plugins = [] } = {}) {
  const options = {
    absWorkingDir: root,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
    plugins,
  };
  const [model, worker, bounds, parseLicense, entitiesLicense] =
    await Promise.all([
      build({
        ...options,
        entryPoints: ["src/roundtrip/model.js"],
        globalName: "hr2exports",
      }),
      build({ ...options, entryPoints: ["src/roundtrip/worker.js"] }),
      build({
        ...options,
        entryPoints: ["src/roundtrip/limits.js"],
        globalName: "hr2bounds",
      }),
      readFile(path.join(root, "LICENSES/parse5-MIT.txt"), "utf8"),
      readFile(path.join(root, "LICENSES/entities-BSD-2-Clause.txt"), "utf8"),
    ]);
  const safe = (s) =>
    s
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  return (
    '<!-- HR2 GENERATED START -->\n<script id="roundtrip-model">\nconst roundTripBounds=(()=>{' +
    bounds.outputFiles[0].text +
    "return Object.freeze(hr2bounds);})();\nconst roundTripModel=(()=>{" +
    model.outputFiles[0].text +
    'return Object.freeze({...hr2exports});})();\n</script>\n<script id="roundtrip-worker" type="application/json">' +
    safe(JSON.stringify(worker.outputFiles[0].text)) +
    '</script>\n<script id="roundtrip-licenses" type="text/plain">' +
    (parseLicense + "\n" + entitiesLicense).replace(
      /<\/script/gi,
      "<\\/script",
    ) +
    "</script>\n<!-- HR2 GENERATED END -->"
  );
}
export function replaceRegion(html, region) {
  const starts = html.match(/<!-- HR2 GENERATED START -->/g) || [],
    ends = html.match(/<!-- HR2 GENERATED END -->/g) || [];
  if (starts.length !== ends.length || starts.length > 1)
    throw new Error("Invalid generated boundaries");
  if (
    starts.length &&
    !/<!-- HR2 GENERATED START -->[\s\S]*?<!-- HR2 GENERATED END -->/.test(html)
  )
    throw new Error("Invalid generated boundary order");
  if (starts.length)
    return html.replace(
      /<!-- HR2 GENERATED START -->[\s\S]*?<!-- HR2 GENERATED END -->/,
      () => region,
    );
  if ((html.match(/<script id="bundle-importer">/g) || []).length !== 1)
    throw new Error("Importer boundary missing");
  return html.replace(
    '<script id="bundle-importer">',
    () => region + '\n<script id="bundle-importer">',
  );
}
async function main() {
  const file = path.join(root, "index.html"),
    html = await readFile(file, "utf8"),
    limits = await readFile(path.join(root, "src/roundtrip/limits.js"), "utf8");
  for (const name of ["INPUT", "DOWNLOAD", "TEMPLATE", "NORMALIZED"]) {
    const app = html.match(
        new RegExp("const MAX_" + name + "_BYTES = ([^;]+);"),
      ),
      shared = limits.match(
        new RegExp("const RT_MAX_" + name + "_BYTES = ([^;]+);"),
      );
    if (!app || !shared || app[1] !== shared[1])
      throw new Error("Shared limit mismatch: " + name);
  }
  const output = replaceRegion(html, await generateRoundtripArtifacts());
  if (process.argv.includes("--check")) {
    if (output !== html)
      throw new Error("Generated roundtrip artifacts are stale");
  } else await writeFile(file, output);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
