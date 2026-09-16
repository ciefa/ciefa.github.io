const fs = require("node:fs/promises"),
  path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../..");
async function generated(overrides = {}) {
  const { generateRoundtripArtifacts, replaceRegion } = await import(
    pathToFileURL(path.join(root, "scripts/build-roundtrip.mjs")).href
  );
  const plugins = [
    {
      name: "fixed-test-limits",
      setup(build) {
        build.onLoad({ filter: /[/\\]limits\.js$/ }, async (args) => {
          let contents = await fs.readFile(args.path, "utf8");
          for (const [key, value] of Object.entries(overrides)) {
            if (
              !/^RT_[A-Z_]+$/.test(key) ||
              !Number.isSafeInteger(value) ||
              value < 0
            )
              throw Error("Invalid fixed limit");
            const re = new RegExp("(export const " + key + " = )[^;]+;", "g");
            if ((contents.match(re) || []).length !== 1)
              throw Error("Limit not unique: " + key);
            contents = contents.replace(
              re,
              (_, prefix) => prefix + value + ";",
            );
          }
          return { contents, loader: "js" };
        });
      },
    },
  ];
  const region = await generateRoundtripArtifacts({ plugins });
  let html = await fs.readFile(path.join(root, "index.html"), "utf8");
  for (const [key, value] of Object.entries(overrides))
    if (/^RT_MAX_(INPUT|DOWNLOAD|TEMPLATE|NORMALIZED)_BYTES$/.test(key)) {
      const name = key.slice(3),
        re = new RegExp("(const " + name + " = )[^;]+;", "g");
      if ((html.match(re) || []).length !== 1)
        throw Error("App limit not unique");
      html = html.replace(re, (_, prefix) => prefix + value + ";");
    }
  return {
    region,
    html: replaceRegion(html, region),
    model: region.match(/<script id="roundtrip-model">([\s\S]*?)<\/script>/)[1],
    worker: JSON.parse(
      region.match(
        /<script id="roundtrip-worker" type="application\/json">([\s\S]*?)<\/script>/,
      )[1],
    ),
  };
}
module.exports = { generated };
