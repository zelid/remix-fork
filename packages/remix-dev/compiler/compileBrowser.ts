import * as path from "path";
import * as fs from "fs/promises";
import { builtinModules as nodeBuiltins } from "module";
import * as esbuild from "esbuild";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { pnpPlugin as yarnPnpPlugin } from "@yarnpkg/esbuild-plugin-pnp";

import { type RemixConfig } from "../config";
import { createAssetsManifest, type AssetsManifest } from "./assets";
import { getAppDependencies } from "./dependencies";
import { loaders } from "./loaders";
import { type CompileOptions } from "./options";
import { browserRouteModulesPlugin } from "./plugins/browserRouteModulesPlugin";
import { cssModulesPlugin } from "./plugins/cssModulesPlugin";
import { cssFilePlugin } from "./plugins/cssFilePlugin";
import { emptyModulesPlugin } from "./plugins/emptyModulesPlugin";
import { mdxPlugin } from "./plugins/mdx";
import { urlImportsPlugin } from "./plugins/urlImportsPlugin";
import { type WriteChannel } from "./utils/channel";
import { writeFileSafe } from "./utils/fs";
import { cssBuildVirtualModule } from "./virtualModules";
import { cssEntryModulePlugin } from "./plugins/cssEntryModulePlugin";

export type BrowserCompiler = {
  // produce ./public/build/
  compile: (manifestChannel: WriteChannel<AssetsManifest>) => Promise<void>;
  dispose: () => void;
};

const getExternals = (remixConfig: RemixConfig): string[] => {
  // For the browser build, exclude node built-ins that don't have a
  // browser-safe alternative installed in node_modules. Nothing should
  // *actually* be external in the browser build (we want to bundle all deps) so
  // this is really just making sure we don't accidentally have any dependencies
  // on node built-ins in browser bundles.
  let dependencies = Object.keys(getAppDependencies(remixConfig));
  let fakeBuiltins = nodeBuiltins.filter((mod) => dependencies.includes(mod));

  if (fakeBuiltins.length > 0) {
    throw new Error(
      `It appears you're using a module that is built in to node, but you installed it as a dependency which could cause problems. Please remove ${fakeBuiltins.join(
        ", "
      )} before continuing.`
    );
  }
  return nodeBuiltins.filter((mod) => !dependencies.includes(mod));
};

const writeAssetsManifest = async (
  config: RemixConfig,
  assetsManifest: AssetsManifest
) => {
  let filename = `manifest-${assetsManifest.version.toUpperCase()}.js`;

  assetsManifest.url = config.publicPath + filename;

  await writeFileSafe(
    path.join(config.assetsBuildDirectory, filename),
    `window.__remixManifest=${JSON.stringify(assetsManifest)};`
  );
};

const createEsbuildConfig = (
  build: "app" | "css",
  config: RemixConfig,
  options: CompileOptions
): esbuild.BuildOptions | esbuild.BuildIncremental => {
  let entryPoints: esbuild.BuildOptions["entryPoints"] = {};
  if (build === "css") {
    entryPoints = {
      "css-bundle": cssBuildVirtualModule.id,
    };
  } else {
    entryPoints = {
      "entry.client": path.resolve(config.appDirectory, config.entryClientFile),
    };

    for (let id of Object.keys(config.routes)) {
      // All route entry points are virtual modules that will be loaded by the
      // browserEntryPointsPlugin. This allows us to tree-shake server-only code
      // that we don't want to run in the browser (i.e. action & loader).
      entryPoints[id] = config.routes[id].file + "?browser";
    }
  }

  let plugins = [
    cssModulesPlugin({
      mode: options.mode,
      emitCss: build === "css",
    }),
    cssEntryModulePlugin(config),
    cssFilePlugin(options),
    urlImportsPlugin(),
    mdxPlugin(config),
    browserRouteModulesPlugin(config, /\?browser$/),
    emptyModulesPlugin(config, /\.server(\.[jt]sx?)?$/),
    NodeModulesPolyfillPlugin(),
    yarnPnpPlugin(),
  ];

  return {
    entryPoints,
    outdir: config.assetsBuildDirectory,
    platform: "browser",
    format: "esm",
    external: getExternals(config),
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    splitting: build !== "css",
    sourcemap: options.sourcemap,
    // As pointed out by https://github.com/evanw/esbuild/issues/2440, when tsconfig is set to
    // `undefined`, esbuild will keep looking for a tsconfig.json recursively up. This unwanted
    // behavior can only be avoided by creating an empty tsconfig file in the root directory.
    tsconfig: config.tsconfigPath,
    mainFields: ["browser", "module", "main"],
    treeShaking: true,
    minify: options.mode === "production",
    entryNames: "[dir]/[name]-[hash]",
    chunkNames: "_shared/[name]-[hash]",
    assetNames: "_assets/[name]-[hash]",
    publicPath: config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.mode),
      "process.env.REMIX_DEV_SERVER_WS_PORT": JSON.stringify(
        config.devServerPort
      ),
    },
    jsx: "automatic",
    jsxDev: options.mode !== "production",
    plugins,
  };
};

export const createBrowserCompiler = (
  remixConfig: RemixConfig,
  options: CompileOptions
): BrowserCompiler => {
  let appCompiler: esbuild.BuildIncremental;
  let cssCompiler: esbuild.BuildIncremental;

  let cssBundlePathPrefix = path.join(
    remixConfig.assetsBuildDirectory,
    "css-bundle"
  );

  let compile = async (manifestChannel: WriteChannel<AssetsManifest>) => {
    let appBuildPromise = !appCompiler
      ? esbuild.build({
          ...createEsbuildConfig("app", remixConfig, options),
          metafile: true,
          incremental: true,
        })
      : appCompiler.rebuild();

    let cssBuildPromise = (
      !cssCompiler
        ? esbuild.build({
            ...createEsbuildConfig("css", remixConfig, options),
            metafile: true,
            write: false,
            incremental: true,
          })
        : cssCompiler.rebuild()
    ).then(async (compiler) => {
      let cssBundlePath: string | undefined;
      let outputFiles = compiler.outputFiles || [];

      await Promise.all(
        outputFiles.map((outputFile) => {
          let outputPath = outputFile.path;

          if (outputPath.startsWith(cssBundlePathPrefix)) {
            if (outputPath.endsWith(".css")) {
              cssBundlePath = outputPath;
              return fs.writeFile(outputPath, outputFile.contents);
            }

            if (outputPath.endsWith(".css.map")) {
              return fs.writeFile(outputPath, outputFile.contents);
            }
          }

          return null;
        })
      );

      return {
        compiler,
        cssBundlePath,
      };
    });

    let [appBuildResult, cssBuildResult] = await Promise.all([
      appBuildPromise,
      cssBuildPromise,
    ]);

    appCompiler = appBuildResult;

    // The types aren't great when combining write: false and incremental: true
    // so we're asserting that it's an incremental build
    cssCompiler = cssBuildResult.compiler as esbuild.BuildIncremental;

    let manifest = await createAssetsManifest({
      config: remixConfig,
      metafile: appCompiler.metafile!,
      cssBundlePath: cssBuildResult.cssBundlePath,
    });
    manifestChannel.write(manifest);
    await writeAssetsManifest(remixConfig, manifest);
  };
  return {
    compile,
    dispose: () => appCompiler?.rebuild.dispose(),
  };
};
