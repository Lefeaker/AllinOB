export type FirefoxAmoSourceArchiveEntry = {
  path: string;
  content: string | null;
};

export type FirefoxAmoSourceArchiveResult = {
  archivePath: string;
  archiveName: string;
  entryCount: number;
};

export type FirefoxAmoSourceArchiveAuditResult = {
  ok: true;
  archivePath: string;
  entryCount: number;
  findings: [];
};

export type FirefoxAmoSourceArchiveOptions = {
  repoRoot?: string;
  outputDir?: string;
  artifactBaseName: string;
  releaseXpiName?: string;
  version: string;
};

export type FirefoxAmoSourceArchiveDependencies = {
  logger?: {
    log: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
  zipDirectoryImpl?: (
    sourceDir: string,
    outputPath: string,
    options?: { ignore?: string[] }
  ) => Promise<void>;
};

export const FIREFOX_AMO_SOURCE_ARCHIVE_SUFFIX: '-source';

export function readFirefoxAmoSourceArchiveEntries(
  archivePath: string
): Promise<FirefoxAmoSourceArchiveEntry[]>;

export function auditFirefoxAmoSourceArchive(
  archivePath: string,
  options?: {
    logger?: {
      log: (...args: unknown[]) => void;
    };
  }
): Promise<FirefoxAmoSourceArchiveAuditResult>;

export function createFirefoxAmoSourceArchive(
  options: FirefoxAmoSourceArchiveOptions,
  dependencies?: FirefoxAmoSourceArchiveDependencies
): Promise<FirefoxAmoSourceArchiveResult>;
