import { rollup } from "rollup";
import configs from "../rollup.config.js";
import path from "node:path";
const desktop = configs[0];
const output = desktop.output[0].file;
const scanner = { input: "src/libs/txtStreamIndex.ts", plugins: desktop.plugins.slice(0, -1),
  output: { file: path.resolve(path.dirname(output), "../../utils/main/txt-scanner.cjs"), format: "cjs", inlineDynamicImports: true } };
for (const config of process.argv.includes("--scanner-only") ? [scanner] : [desktop, scanner]) {
  const build = await rollup(config);
  for (const destination of Array.isArray(config.output) ? config.output : [config.output]) await build.write(destination);
  await build.close();
}
