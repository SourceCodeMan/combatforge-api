import { rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";


const entry = fileURLToPath(new URL("./ci-routes.mjs", import.meta.url));
const outfile = fileURLToPath(new URL(`../.ci-routes-${process.pid}.mjs`, import.meta.url));

try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    sourcemap: "inline",
    logLevel: "warning",
  });
  await import(`${pathToFileURL(outfile).href}?run=${Date.now()}`);
} finally {
  await rm(outfile, { force: true });
}
