import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const OVERLAY_NAMESPACE = 'portable-overlay-source';
const PUBLIC_NAMESPACE = 'portable-public-source';
const RESOLVE_NAMESPACE = 'file';

const OVERLAY_LOADERS = new Map([
  ['.js', 'js'],
  ['.jsx', 'jsx'],
  ['.mjs', 'js'],
  ['.json', 'json'],
  ['.ts', 'ts'],
  ['.tsx', 'tsx']
]);

function portableBuildError(code, message) {
  return new Error(`[${code}] ${message}`);
}

function canonicalDirectory(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw portableBuildError(
      'PORTABLE_BUILD_SOURCE_MISSING',
      `${label} does not exist: ${absolute}`
    );
  }
  const canonical = realpathSync(absolute);
  if (!statSync(canonical).isDirectory()) {
    throw portableBuildError(
      'PORTABLE_BUILD_SOURCE_MISSING',
      `${label} is not a directory: ${canonical}`
    );
  }
  return canonical;
}

function canonicalSource(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw portableBuildError('PORTABLE_BUILD_SOURCE_MISSING', `source does not exist: ${absolute}`);
  }
  const canonical = realpathSync(absolute);
  if (!statSync(canonical).isFile()) {
    throw portableBuildError('PORTABLE_BUILD_SOURCE_MISSING', `source is not a file: ${canonical}`);
  }
  return canonical;
}

function isInsideRoot(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function rootRelativePath(root, path) {
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw portableBuildError(
      'PORTABLE_BUILD_ROOT_ESCAPE',
      `source must stay inside its declared root: ${path}`
    );
  }
  return rel.split(sep).join('/');
}

function isRelativeSpecifier(path) {
  return (
    path === '.' ||
    path === '..' ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    path.startsWith('.\\') ||
    path.startsWith('..\\')
  );
}

function overlayLoader(path) {
  const extension = extname(path).toLowerCase();
  const loader = OVERLAY_LOADERS.get(extension);
  if (!loader) {
    throw portableBuildError(
      'PORTABLE_BUILD_UNSUPPORTED_LOADER',
      `unsupported overlay source extension ${extension || '(none)'}: ${path}`
    );
  }
  return loader;
}

export function createPortableBuildIdentity({ publicRoot, overlayRoots = [] }) {
  const canonicalPublicRoot = canonicalDirectory(publicRoot, 'publicRoot');
  const canonicalOverlayRoots = overlayRoots.map((root, index) =>
    canonicalDirectory(root, `overlayRoots[${index}]`)
  );
  const uniqueOverlayRoots = new Set(canonicalOverlayRoots);
  if (uniqueOverlayRoots.size !== canonicalOverlayRoots.length) {
    throw portableBuildError(
      'PORTABLE_BUILD_IDENTITY_COLLISION',
      'declared overlay roots must be canonically unique'
    );
  }
  for (let left = 0; left < canonicalOverlayRoots.length; left += 1) {
    for (let right = left + 1; right < canonicalOverlayRoots.length; right += 1) {
      if (
        isInsideRoot(canonicalOverlayRoots[left], canonicalOverlayRoots[right]) ||
        isInsideRoot(canonicalOverlayRoots[right], canonicalOverlayRoots[left])
      ) {
        throw portableBuildError(
          'PORTABLE_BUILD_IDENTITY_COLLISION',
          `declared overlay roots overlap: ${canonicalOverlayRoots[left]} and ${canonicalOverlayRoots[right]}`
        );
      }
    }
  }
  for (const overlayRoot of canonicalOverlayRoots) {
    if (
      isInsideRoot(overlayRoot, canonicalPublicRoot) ||
      isInsideRoot(canonicalPublicRoot, overlayRoot)
    ) {
      throw portableBuildError(
        'PORTABLE_BUILD_IDENTITY_COLLISION',
        `public and overlay roots must not overlap: ${canonicalPublicRoot} and ${overlayRoot}`
      );
    }
  }

  const logicalToReal = new Map();
  const identityToken = Object.freeze({});

  function classifyCanonicalSource(canonical) {
    const overlayMatches = canonicalOverlayRoots
      .map((root, index) => ({ index, root }))
      .filter(({ root }) => isInsideRoot(canonical, root));
    if (overlayMatches.length > 1) {
      throw portableBuildError(
        'PORTABLE_BUILD_IDENTITY_COLLISION',
        `source matches more than one declared overlay root: ${canonical}`
      );
    }
    if (overlayMatches.length === 1) {
      const [{ index, root }] = overlayMatches;
      return {
        kind: 'overlay',
        namespace: OVERLAY_NAMESPACE,
        path: `overlay-${index}/${rootRelativePath(root, canonical)}`,
        root,
        rootIndex: index
      };
    }
    if (isInsideRoot(canonical, canonicalPublicRoot)) {
      return {
        kind: 'public',
        namespace: PUBLIC_NAMESPACE,
        path: `public/${rootRelativePath(canonicalPublicRoot, canonical)}`,
        root: canonicalPublicRoot,
        rootIndex: null
      };
    }
    throw portableBuildError(
      'PORTABLE_BUILD_ROOT_ESCAPE',
      `source is outside the declared public and overlay roots: ${canonical}`
    );
  }

  function identifySource(path) {
    const canonical = canonicalSource(path);
    return { canonical, ...classifyCanonicalSource(canonical) };
  }

  function sourceIdentity(path) {
    const { kind, namespace, path: logicalPath, rootIndex } = identifySource(path);
    return { identityToken, kind, namespace, path: logicalPath, rootIndex };
  }

  function bindOverlaySource(canonical, classification = classifyCanonicalSource(canonical)) {
    if (classification.kind !== 'overlay') {
      return null;
    }
    overlayLoader(canonical);
    const existing = logicalToReal.get(classification.path);
    if (existing && existing !== canonical) {
      throw portableBuildError(
        'PORTABLE_BUILD_IDENTITY_COLLISION',
        `logical source ${classification.path} maps to both ${existing} and ${canonical}`
      );
    }
    logicalToReal.set(classification.path, canonical);
    return {
      namespace: OVERLAY_NAMESPACE,
      path: classification.path
    };
  }

  const plugin = {
    name: 'portable-build-identity',
    setup(build) {
      const workingDirectory = canonicalDirectory(
        build.initialOptions.absWorkingDir ?? canonicalPublicRoot,
        'absWorkingDir'
      );
      if (workingDirectory !== canonicalPublicRoot) {
        throw portableBuildError(
          'PORTABLE_BUILD_ROOT_ESCAPE',
          `absWorkingDir must equal canonical publicRoot: ${workingDirectory}`
        );
      }

      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== 'entry-point') {
          return undefined;
        }
        const candidate = isAbsolute(args.path)
          ? args.path
          : resolve(args.resolveDir || workingDirectory, args.path);
        if (!existsSync(candidate)) {
          if (isAbsolute(args.path)) {
            throw portableBuildError(
              'PORTABLE_BUILD_SOURCE_MISSING',
              `absolute entry point does not exist: ${candidate}`
            );
          }
          return undefined;
        }
        const canonical = canonicalSource(candidate);
        const overlayMatch = canonicalOverlayRoots.some((root) => isInsideRoot(canonical, root));
        if (overlayMatch) {
          return bindOverlaySource(canonical);
        }
        if (isInsideRoot(canonical, canonicalPublicRoot)) {
          return undefined;
        }
        throw portableBuildError(
          'PORTABLE_BUILD_ROOT_ESCAPE',
          `entry point is outside the declared public and overlay roots: ${canonical}`
        );
      });

      build.onResolve({ filter: /.*/, namespace: OVERLAY_NAMESPACE }, async (args) => {
        const importer = logicalToReal.get(args.importer);
        if (!importer) {
          throw portableBuildError(
            'PORTABLE_BUILD_IDENTITY_COLLISION',
            `logical importer has no real-path binding: ${args.importer}`
          );
        }
        const importerClassification = classifyCanonicalSource(importer);
        const resolved = await build.resolve(args.path, {
          importer,
          kind: args.kind,
          namespace: RESOLVE_NAMESPACE,
          resolveDir: dirname(importer),
          with: args.with
        });
        if (resolved.errors.length > 0 || (!resolved.external && !resolved.path)) {
          const details = resolved.errors.map((error) => error.text).join('; ');
          throw portableBuildError(
            'PORTABLE_BUILD_SOURCE_MISSING',
            `cannot resolve ${args.path} from ${importer}${details ? `: ${details}` : ''}`
          );
        }
        if (resolved.external) {
          if (isRelativeSpecifier(args.path)) {
            throw portableBuildError(
              'PORTABLE_BUILD_ROOT_ESCAPE',
              `relative overlay import cannot be external: ${args.path}`
            );
          }
          return resolved;
        }
        if (resolved.namespace !== RESOLVE_NAMESPACE) {
          if (isRelativeSpecifier(args.path)) {
            const targetIdentity = resolved.pluginData?.portableBuildIdentity;
            if (
              targetIdentity?.identityToken !== identityToken ||
              targetIdentity?.kind !== 'overlay' ||
              targetIdentity.rootIndex !== importerClassification.rootIndex
            ) {
              throw portableBuildError(
                'PORTABLE_BUILD_ROOT_ESCAPE',
                `relative overlay import resolved through an untrusted namespace or root: ${args.path}`
              );
            }
          }
          return resolved;
        }

        const target = identifySource(resolved.path);
        if (target.kind === 'overlay') {
          if (target.rootIndex !== importerClassification.rootIndex) {
            throw portableBuildError(
              'PORTABLE_BUILD_ROOT_ESCAPE',
              `overlay import crosses declared roots: ${args.path}`
            );
          }
          return {
            ...bindOverlaySource(target.canonical, target),
            external: resolved.external,
            sideEffects: resolved.sideEffects,
            suffix: resolved.suffix,
            warnings: resolved.warnings
          };
        }
        if (isRelativeSpecifier(args.path)) {
          throw portableBuildError(
            'PORTABLE_BUILD_ROOT_ESCAPE',
            `relative overlay import escapes its declared root: ${args.path}`
          );
        }
        return resolved;
      });

      build.onLoad({ filter: /.*/, namespace: OVERLAY_NAMESPACE }, (args) => {
        const sourcePath = logicalToReal.get(args.path);
        if (!sourcePath || !existsSync(sourcePath)) {
          throw portableBuildError(
            'PORTABLE_BUILD_SOURCE_MISSING',
            `logical overlay source is missing: ${args.path}`
          );
        }
        const currentCanonical = canonicalSource(sourcePath);
        const currentClassification = classifyCanonicalSource(currentCanonical);
        if (
          currentCanonical !== sourcePath ||
          currentClassification.kind !== 'overlay' ||
          currentClassification.path !== args.path
        ) {
          throw portableBuildError(
            'PORTABLE_BUILD_IDENTITY_COLLISION',
            `overlay source binding changed after resolution: ${args.path}`
          );
        }
        return {
          contents: readFileSync(currentCanonical),
          loader: overlayLoader(currentCanonical),
          resolveDir: dirname(currentCanonical),
          watchFiles: [currentCanonical]
        };
      });
    }
  };

  return { plugin, sourceIdentity };
}
