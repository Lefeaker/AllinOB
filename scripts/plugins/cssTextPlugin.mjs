import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPortableBuildIdentity } from './portableBuildIdentityPlugin.mjs';

function sourceKey(namespace, path) {
  return `${namespace}\0${path}`;
}

/**
 * esbuild plugin to import CSS files as text strings
 * Allows `import styles from './styles.css?inline';`
 */
export function cssTextPlugin(options = {}) {
  return {
    name: 'css-text',
    setup(build) {
      const publicRoot = resolve(
        options.publicRoot ?? build.initialOptions.absWorkingDir ?? process.cwd()
      );
      const fallbackIdentity = options.sourceIdentity
        ? null
        : createPortableBuildIdentity({ publicRoot });
      const sourceIdentity = options.sourceIdentity
        ? (path) => options.sourceIdentity(path)
        : (path) => fallbackIdentity.sourceIdentity(path);
      const logicalToReal = new Map();

      build.onResolve({ filter: /\.css\?inline$/ }, (args) => {
        const requestedPath = args.path.slice(0, -'?inline'.length);
        const candidate = resolve(args.resolveDir || publicRoot, requestedPath);
        if (!existsSync(candidate)) {
          throw new Error(
            `[PORTABLE_BUILD_SOURCE_MISSING] inline CSS does not exist: ${candidate}`
          );
        }
        const realPath = realpathSync(candidate);
        const identity = sourceIdentity(realPath);
        const importerIdentity = args.pluginData?.portableBuildIdentity;
        if (
          importerIdentity?.kind === 'overlay' &&
          (identity.identityToken !== importerIdentity.identityToken ||
            identity.kind !== 'overlay' ||
            identity.rootIndex !== importerIdentity.rootIndex)
        ) {
          throw new Error(
            `[PORTABLE_BUILD_ROOT_ESCAPE] inline CSS crosses declared overlay roots: ${args.path}`
          );
        }
        const path = `${identity.namespace}/${identity.path}`;
        const key = sourceKey('css-text', path);
        const existing = logicalToReal.get(key);
        if (existing && existing !== realPath) {
          throw new Error(
            `[PORTABLE_BUILD_IDENTITY_COLLISION] inline CSS ${path} maps to both ${existing} and ${realPath}`
          );
        }
        logicalToReal.set(key, realPath);
        return {
          path,
          namespace: 'css-text',
          pluginData: {
            portableBuildIdentity: identity
          },
          watchFiles: [realPath]
        };
      });

      build.onLoad({ filter: /.*/, namespace: 'css-text' }, (args) => {
        const realPath = logicalToReal.get(sourceKey(args.namespace, args.path));
        if (!realPath || !existsSync(realPath)) {
          throw new Error(`[PORTABLE_BUILD_SOURCE_MISSING] inline CSS is missing: ${args.path}`);
        }
        const currentRealPath = realpathSync(realPath);
        const currentIdentity = sourceIdentity(currentRealPath);
        const currentLogicalPath = `${currentIdentity.namespace}/${currentIdentity.path}`;
        if (currentRealPath !== realPath || currentLogicalPath !== args.path) {
          throw new Error(
            `[PORTABLE_BUILD_IDENTITY_COLLISION] inline CSS binding changed after resolution: ${args.path}`
          );
        }
        const css = readFileSync(currentRealPath, 'utf8');
        const minified = css
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .replace(/\s*([{}:;,])\s*/g, '$1')
          .trim();

        return {
          contents: `export default ${JSON.stringify(minified)};`,
          loader: 'js',
          watchFiles: [currentRealPath]
        };
      });
    }
  };
}
