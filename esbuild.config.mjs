import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();
const watch = process.argv.includes("--watch");
const contexts = await Promise.all([esbuild.context(presets.esbuild.worker), esbuild.context(presets.esbuild.manifest)]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("esbuild watching worker + manifest");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
