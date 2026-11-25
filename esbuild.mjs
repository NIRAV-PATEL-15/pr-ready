import * as esbuild from "esbuild";
const watch = process.argv.includes("--watch");
const common = { bundle: true, minify: !watch, sourcemap: watch ? "inline" : false, logLevel: "info" };
const ctx = await esbuild.context({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node18", external: ["vscode"] });
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
