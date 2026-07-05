import { describe, expect, it } from 'vitest';

type NonProductionSourceModule = {
  classifySourceFile: (input: Record<string, unknown>) => {
    decision: string;
    requiredAction: string;
    owner?: string;
    deletionCondition?: string;
  };
  collectSourceImportGraph: (
    files: Array<{ path: string; source: string }>,
    sourceFiles: string[]
  ) => {
    ownersByTarget: Map<string, string[]>;
    targetsByOwner: Map<string, string[]>;
  };
  formatNonProductionSourceReport: (rows: Array<Record<string, unknown>>) => string;
  formatNonProductionSourceJson: (rows: Array<Record<string, unknown>>) => string;
  validateNonProductionSourceCheck: (rows: Array<Record<string, unknown>>) => {
    ok: boolean;
    violations: Array<{ file: string; reason: string }>;
  };
  validateNonProductionSourceThresholds: (
    rows: Array<Record<string, unknown>>,
    limits: { maxMigrateImportOwner?: number }
  ) => {
    ok: boolean;
    violations: Array<{ metric: string; actual: number; max: number }>;
  };
  parseArgs: (argv: string[]) => {
    checkMode: boolean;
    format: string;
    output: string | null;
    maxMigrateImportOwner?: number;
  };
  evaluateNonProductionSourceGates: (
    rows: object[],
    options: { checkMode?: boolean; maxMigrateImportOwner?: number }
  ) => {
    ok: boolean;
    violations: object[];
  };
  resolveSourceImport: (
    importerPath: string,
    specifier: string,
    sourceFileSet: Set<string>
  ) => string | null;
  stripImportQueryHash: (specifier: string) => string;
};

const {
  classifySourceFile,
  collectSourceImportGraph,
  evaluateNonProductionSourceGates,
  formatNonProductionSourceJson,
  formatNonProductionSourceReport,
  parseArgs,
  resolveSourceImport,
  stripImportQueryHash,
  validateNonProductionSourceCheck,
  validateNonProductionSourceThresholds
} = (await import(
  // @ts-expect-error Tool modules are authored as executable ESM without .d.ts files.
  '../../../tools/report-non-production-source.mjs'
)) as NonProductionSourceModule;

const approvedPostTestDeleteCandidate = [
  'src',
  'options',
  'widgets',
  'FragmentSettingsWidget.ts'
].join('/');
const approvedPostWidgetDeleteCandidate = ['src', 'options', 'widgets', 'UsageWidget.ts'].join('/');
const approvedReadingVideoDeleteCandidate = [
  'src',
  'options',
  'widgets',
  'ReadingSettingsWidget.ts'
].join('/');
const approvedFamilyWidgetDeleteCandidate = ['src', 'options', 'widgets', 'PrivacyWidget.ts'].join(
  '/'
);
const approvedUtilsDefaultsDeleteCandidate = ['src', 'options', 'utils', 'defaults.ts'].join('/');
const approvedSectionDependencyDeleteCandidate = [
  'src',
  'options',
  'widgets',
  'VideoSettingsWidget.ts'
].join('/');
const approvedZagComboboxDeleteCandidate = ['src', 'ui', 'ZagCombobox.js'].join('/');

function input(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/options/widgets/ExampleWidget.ts',
    productionBuildGraphOwners: [],
    productionImportOwners: [],
    testOwners: [],
    scriptOwners: [],
    publicAssetOwners: [],
    requiredVerificationOwners: [],
    explicitRetainPatterns: [],
    explicitClassificationPatterns: [],
    explicitDeleteNowPatterns: [],
    ...overrides
  };
}

describe('report-non-production-source', () => {
  it('marks source with production build ownership as retain-production', () => {
    expect(
      classifySourceFile(
        input({
          productionBuildGraphOwners: ['options/index'],
          productionImportOwners: ['src/options/app/bootstrap.ts']
        })
      ).decision
    ).toBe('retain-production');
  });

  it('marks source owned only by tests as migrate-test-owner', () => {
    const result = classifySourceFile(
      input({
        testOwners: ['tests/unit/options/legacyWidget.test.ts']
      })
    );

    expect(result.decision).toBe('migrate-test-owner');
    expect(result.owner).toContain('test');
    expect(result.requiredAction).toContain('Move behavior coverage');
  });

  it('uses explicit retained facade rules with owner and deletion condition', () => {
    const result = classifySourceFile(
      input({
        file: 'src/ui/domains/theme/index.ts',
        explicitClassificationPatterns: [
          {
            pattern: 'src/ui/domains/theme/index.ts',
            decision: 'retain-production-facade',
            owner: 'theme domain public barrel',
            deletionCondition: 'delete only after public imports move to concrete theme module'
          }
        ]
      })
    );

    expect(result.decision).toBe('retain-production-facade');
    expect(result.owner).toBe('theme domain public barrel');
    expect(result.deletionCondition).toContain('public imports');
  });

  it('requires import-owner migration before an explicit facade can be deletion-approved', () => {
    const result = classifySourceFile(
      input({
        file: 'src/background/sinks/obsidianRest.ts',
        retainedSourceImportOwners: [
          'src/infrastructure/restClient.ts',
          'src/shared/interfaces/restClient.ts'
        ],
        explicitClassificationPatterns: [
          {
            pattern: 'src/background/sinks/obsidianRest.ts',
            decision: 'retain-production-facade',
            owner: 'background sink compatibility boundary',
            deletionCondition:
              'delete only after Obsidian sink imports move to the current writer/service owner'
          }
        ]
      })
    );

    expect(result.decision).toBe('migrate-import-owner');
    expect(result.owner).toBe('retained source import graph owner');
    expect(result.requiredAction).toContain('Remove retained source import');
  });

  it('supports exact retained classifications for completion-audit source contracts', () => {
    const retainedContracts: Array<{
      pattern: string;
      owner: string;
      testOwners?: string[];
      scriptOwners?: string[];
      publicAssetOwners?: string[];
    }> = [
      {
        pattern: 'src/components/trial-notice.ts',
        owner: 'trial notice documented UI contract',
        testOwners: ['tests/unit/components/trialNotice.test.ts']
      },
      {
        pattern: 'src/shared/capabilities/capabilityPolicy.ts',
        owner: 'public restore capability policy contract',
        testOwners: ['tests/unit/shared/capabilities/capabilityPolicy.test.ts']
      },
      {
        pattern: 'src/content/clipper/shared/styleManager.ts',
        owner: 'clipper inline style manager documented contract',
        testOwners: ['tests/unit/content/styleManager.test.ts']
      },
      {
        pattern: 'src/env.d.ts',
        owner: 'TypeScript build and audit global declaration contract',
        scriptOwners: ['tools/report-ui-architecture-alignment.mjs']
      },
      {
        pattern: 'src/options/app/buttonPressScrollGuard.ts',
        owner: 'Options button action scroll guard owner',
        testOwners: ['tests/unit/options/productionStitchShell.test.ts']
      },
      {
        pattern: 'src/options/stitch/runtime/actions.ts',
        owner: 'Stitch runtime action id contract',
        testOwners: ['tests/unit/options/stitchSharedRegistry.test.ts']
      },
      {
        pattern: 'src/options/stitch/styles/variants/stitch-secondary.css',
        owner: 'Stitch Secondary static style asset contract',
        publicAssetOwners: ['public/content-orchestrator-harness.html']
      },
      {
        pattern: 'src/styles/clipper/highlight-themes.css',
        owner: 'reader and video highlight theme build asset contract',
        scriptOwners: ['scripts/build.mjs']
      },
      {
        pattern: 'src/styles/design-tokens.css',
        owner: 'design token source-of-truth asset',
        scriptOwners: ['scripts/build.mjs']
      },
      {
        pattern: 'src/ui/foundation/tokens/index.ts',
        owner: 'design token metadata source contract',
        scriptOwners: ['tools/report-design-system-doc.mjs']
      },
      {
        pattern: 'src/ui/foundation/keyboard/index.ts',
        owner: 'UI foundation keyboard source-of-truth boundary',
        scriptOwners: ['tools/report-ui-architecture-alignment.mjs']
      },
      {
        pattern: 'src/ui/hosts/options/index.ts',
        owner: 'Options UI host source-of-truth boundary',
        scriptOwners: ['tools/report-ui-architecture-alignment.mjs']
      }
    ];

    for (const contract of retainedContracts) {
      const result = classifySourceFile(
        input({
          file: contract.pattern,
          testOwners: contract.testOwners ?? [],
          scriptOwners: contract.scriptOwners ?? [],
          publicAssetOwners: contract.publicAssetOwners ?? [],
          explicitClassificationPatterns: [
            {
              pattern: contract.pattern,
              decision: 'retain-production-facade',
              owner: contract.owner,
              deletionCondition: 'delete only after owner-approved migration or six-proof deletion'
            }
          ]
        })
      );

      expect(result.decision).toBe('retain-production-facade');
      expect(result.owner).toBe(contract.owner);
    }
  });

  it('uses explicit migration rules without making unknown files pass by default', () => {
    const result = classifySourceFile(
      input({
        file: 'src/options/widgets/shared/usage/usageDashboardState.ts',
        explicitClassificationPatterns: [
          {
            pattern: 'src/options/widgets/shared/usage/**',
            decision: 'migrate-test-owner',
            owner: 'legacy Usage widget helper retained by old widget tests',
            deletionCondition: 'delete after usage behavior is covered by production Stitch tests'
          }
        ]
      })
    );

    expect(result.decision).toBe('migrate-test-owner');
    expect(result.owner).toContain('legacy Usage');
    expect(classifySourceFile(input({ file: 'src/unknown/unused.ts' })).decision).toBe(
      'stop-unknown'
    );
  });

  it('matches explicit brace classification patterns without broadening ownership', () => {
    const result = classifySourceFile(
      input({
        file: 'src/content/reader/styles.ts',
        explicitClassificationPatterns: [
          {
            pattern: 'src/content/reader/{highlightController,sessionExportUtils,styles,types}.ts',
            decision: 'retain-production-facade',
            owner: 'reader runtime compatibility contract',
            deletionCondition: 'delete only after reader runtime imports migrate'
          }
        ]
      })
    );

    expect(result.decision).toBe('retain-production-facade');
    expect(result.owner).toContain('reader runtime');
    expect(
      classifySourceFile(
        input({
          file: 'src/content/reader/unrelated.ts',
          explicitClassificationPatterns: [
            {
              pattern:
                'src/content/reader/{highlightController,sessionExportUtils,styles,types}.ts',
              decision: 'retain-production-facade',
              owner: 'reader runtime compatibility contract',
              deletionCondition: 'delete only after reader runtime imports migrate'
            }
          ]
        })
      ).decision
    ).toBe('stop-unknown');
  });

  it('strips query/hash suffixes before resolving source imports', () => {
    const sourceFileSet = new Set([
      'src/content/video/videoControlBarStyles.ts',
      'src/content/video/video-control-bar.css'
    ]);

    expect(stripImportQueryHash('./video-control-bar.css?inline')).toBe('./video-control-bar.css');
    expect(stripImportQueryHash('./video-control-bar.css?inline#v=1')).toBe(
      './video-control-bar.css'
    );
    expect(
      resolveSourceImport(
        'src/content/video/videoControlBarStyles.ts',
        './video-control-bar.css?inline',
        sourceFileSet
      )
    ).toBe('src/content/video/video-control-bar.css');
  });

  it('treats css imported via ?inline from a production source as production-owned', () => {
    const sourceFiles = [
      'src/content/video/videoControlBarStyles.ts',
      'src/content/video/video-control-bar.css'
    ];
    const importGraph = collectSourceImportGraph(
      [
        {
          path: 'src/content/video/videoControlBarStyles.ts',
          source:
            "import cssText from './video-control-bar.css?inline';\nexport const style = cssText;\n"
        },
        {
          path: 'src/content/video/video-control-bar.css',
          source: '.video-control-bar { color: white; }\n'
        }
      ],
      sourceFiles
    );

    const result = classifySourceFile(
      input({
        file: 'src/content/video/video-control-bar.css',
        productionImportOwners:
          importGraph.ownersByTarget.get('src/content/video/video-control-bar.css') ?? [],
        testOwners: [
          'tests/e2e/videoListenerScope.fixture.test.ts',
          'tests/unit/content/video/videoControlBarButton.test.ts'
        ]
      })
    );

    expect(result.decision).toBe('retain-production');
    expect(result.requiredAction).toContain('production ownership');
  });

  it('does not allow delete-now when one owner proof is unknown', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostTestDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'unknown',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate]
      })
    );

    expect(result.decision).toBe('stop-unknown');
    expect(result.requiredAction).toContain('six owner proofs');
  });

  it('blocks delete-now when any deletion-proof owner surface is still referenced', () => {
    const ownerSurfaces: Array<{
      name: string;
      overrides: Record<string, unknown>;
      expectedDecision: string;
    }> = [
      {
        name: 'production build graph',
        overrides: { productionBuildGraphOwners: ['options/index'] },
        expectedDecision: 'retain-production'
      },
      {
        name: 'production import graph',
        overrides: { productionImportOwners: ['src/options/app/bootstrap.ts'] },
        expectedDecision: 'retain-production'
      },
      {
        name: 'package script reference',
        overrides: { scriptOwners: ['package.json#scripts.package'] },
        expectedDecision: 'migrate-script-owner'
      },
      {
        name: 'build script reference',
        overrides: { scriptOwners: ['scripts/build.mjs'] },
        expectedDecision: 'migrate-script-owner'
      },
      {
        name: 'public or manifest asset reference',
        overrides: { publicAssetOwners: ['public/manifest.json'] },
        expectedDecision: 'migrate-script-owner'
      },
      {
        name: 'unit test reference',
        overrides: { testOwners: ['tests/unit/options/legacyWidget.test.ts'] },
        expectedDecision: 'migrate-test-owner'
      },
      {
        name: 'visual or browser check reference',
        overrides: { testOwners: ['tests/visual/migration-harness.spec.ts'] },
        expectedDecision: 'migrate-test-owner'
      },
      {
        name: 'required verification command reference',
        overrides: { requiredVerificationOwners: ['package.json#scripts.quality'] },
        expectedDecision: 'migrate-test-owner'
      }
    ];

    for (const { name, overrides, expectedDecision } of ownerSurfaces) {
      expect(
        classifySourceFile(
          input({
            file: approvedPostTestDeleteCandidate,
            explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate],
            ...overrides
          })
        ).decision,
        name
      ).toBe(expectedDecision);
    }
  });

  it('marks explicit unowned source as delete-now only after all six proofs are empty', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostTestDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate]
      })
    );

    expect(result.decision).toBe('delete-now');
  });

  it('marks exact owner-approved post-widget candidates as delete-now after all six proofs are empty', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostWidgetDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedPostWidgetDeleteCandidate]
      })
    );

    expect(result.decision).toBe('delete-now');
    expect(result.requiredAction).toContain('planned deletion milestone');
  });

  it('marks exact reading and video widget candidates as delete-now after all six proofs are empty', () => {
    const result = classifySourceFile(
      input({
        file: approvedReadingVideoDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedReadingVideoDeleteCandidate]
      })
    );

    expect(result.decision).toBe('delete-now');
  });

  it('marks exact family widget candidates as delete-now after all six proofs are empty', () => {
    const result = classifySourceFile(
      input({
        file: approvedFamilyWidgetDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedFamilyWidgetDeleteCandidate]
      })
    );

    expect(result.decision).toBe('delete-now');
  });

  it('marks the retired ZagCombobox source as delete-now after all six proofs are empty', () => {
    const result = classifySourceFile(
      input({
        file: approvedZagComboboxDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedZagComboboxDeleteCandidate]
      })
    );

    expect(result.decision).toBe('delete-now');
  });

  it('keeps exact post-test-delete candidates out of delete-now when any proof is non-empty', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostTestDeleteCandidate,
        scriptOwners: ['tools/report-ui-architecture-alignment.mjs'],
        explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-script-owner');
  });

  it('does not mark unapproved unowned source as delete-now', () => {
    const result = classifySourceFile(
      input({
        file: 'src/options/components/sections/UnapprovedLegacySection.ts',
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate]
      })
    );

    expect(result.decision).toBe('stop-unknown');
  });

  it('does not accept broad delete-now directory patterns', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostTestDeleteCandidate,
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: ['src/options/components/**']
      })
    );

    expect(result.decision).toBe('stop-unknown');
  });

  it('does not treat retained test owners as delete-now even for approved candidates', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostTestDeleteCandidate,
        testOwners: ['tests/unit/options/widgets/FragmentSettingsWidget.retainedCoverage.test.ts'],
        explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-test-owner');
  });

  it('does not classify exact approved source as delete-now while retained source imports it', () => {
    const result = classifySourceFile(
      input({
        file: approvedUtilsDefaultsDeleteCandidate,
        retainedSourceImportOwners: ['src/options/utils/index.ts'],
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedUtilsDefaultsDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-import-owner');
    expect(result.owner).toContain('retained source import');
  });

  it('does not classify defaults as delete-now while re-exported by a retained source barrel', () => {
    const result = classifySourceFile(
      input({
        file: approvedUtilsDefaultsDeleteCandidate,
        retainedSourceImportOwners: ['src/options/utils/index.ts'],
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedUtilsDefaultsDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-import-owner');
    expect(result.deletionCondition).toContain('re-exports');
  });

  it('does not classify approved files as delete-now while retained source imports remain', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostTestDeleteCandidate,
        retainedSourceImportOwners: ['src/options/utils/index.ts'],
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedPostTestDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-import-owner');
  });

  it('does not classify an approved source as delete-now while it imports retained source dependencies', () => {
    const result = classifySourceFile(
      input({
        file: approvedSectionDependencyDeleteCandidate,
        retainedSourceImportTargets: [
          'src/options/utils/defaults.ts',
          'src/shared/types/options.ts'
        ],
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        explicitDeleteNowPatterns: [approvedSectionDependencyDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-import-owner');
    expect(result.deletionCondition).toContain('dependencies');
  });

  it('does not treat retained test owners as delete-now for approved post-widget candidates', () => {
    const result = classifySourceFile(
      input({
        file: approvedPostWidgetDeleteCandidate,
        testOwners: ['tests/unit/options/UsageWidget.retainedLegacyCoverage.test.ts'],
        explicitDeleteNowPatterns: [approvedPostWidgetDeleteCandidate]
      })
    );

    expect(result.decision).toBe('migrate-test-owner');
  });

  it('fails unknown source outside production build graph closed', () => {
    const result = classifySourceFile(input({ file: 'src/unknown/unused.ts' }));

    expect(result.decision).toBe('stop-unknown');
    expect(result.requiredAction).toContain('Classify ownership');
  });

  it('formats a report with stable headings', () => {
    const report = formatNonProductionSourceReport([
      classifySourceFile(input({ testOwners: ['tests/unit/options/example.test.ts'] }))
    ]);

    expect(report).toContain('Non-Production Source Ownership Report');
    expect(report).toContain('Owner');
    expect(report).toContain('Deletion condition');
    expect(report).toContain('migrate-test-owner');
    expect(report).toContain('src/options/widgets/ExampleWidget.ts');
  });

  it('keeps report mode inventory visible for migration rows', () => {
    const report = formatNonProductionSourceReport([
      classifySourceFile(input({ retainedSourceImportOwners: ['src/options/utils/index.ts'] })),
      classifySourceFile(input({ scriptOwners: ['tools/report-ui-architecture-alignment.mjs'] })),
      classifySourceFile(input({ testOwners: ['tests/unit/options/example.test.ts'] }))
    ]);

    expect(report).toContain('migrate-import-owner');
    expect(report).toContain('migrate-script-owner');
    expect(report).toContain('migrate-test-owner');
  });

  it('formats JSON with decision counts, unsafe delete-now rows, and migrate import owners', () => {
    const json = formatNonProductionSourceJson([
      classifySourceFile(
        input({
          retainedSourceImportOwners: ['src/options/utils/index.ts']
        })
      ),
      {
        file: approvedPostTestDeleteCandidate,
        decision: 'delete-now',
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'owned',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        productionBuildGraphOwners: [],
        retainedSourceImportOwners: [],
        retainedSourceImportTargets: [],
        testOwners: [],
        scriptOwners: ['tools/report-ui-architecture-alignment.mjs'],
        publicAssetOwners: [],
        requiredVerificationOwners: []
      }
    ]);
    const summary = JSON.parse(json) as {
      decisionCounts: Record<string, number>;
      unsafeDeleteNow: Array<{ file: string; reason: string }>;
      migrateImportOwner: Array<{
        file: string;
        productionBuildOwners: string[];
        importOwners: string[];
        requiredAction: string;
      }>;
    };

    expect(summary.decisionCounts['migrate-import-owner']).toBe(1);
    expect(summary.decisionCounts['delete-now']).toBe(1);
    expect(summary.unsafeDeleteNow[0]?.file).toBe(approvedPostTestDeleteCandidate);
    expect(summary.unsafeDeleteNow[0]?.reason).toContain('packageBuildScripts');
    expect(summary.migrateImportOwner[0]).toMatchObject({
      file: 'src/options/widgets/ExampleWidget.ts',
      productionBuildOwners: [],
      importOwners: ['src/options/utils/index.ts'],
      requiredAction:
        'Remove retained source import/re-export/dependency ownership before deletion.'
    });
  });

  it('validates migrate-import-owner thresholds at exact count and fails when exceeded', () => {
    const rows = [
      classifySourceFile(input({ retainedSourceImportOwners: ['src/options/utils/index.ts'] }))
    ];

    expect(validateNonProductionSourceThresholds(rows, { maxMigrateImportOwner: 1 }).ok).toBe(true);

    const result = validateNonProductionSourceThresholds(rows, { maxMigrateImportOwner: 0 });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toEqual({
      metric: 'migrate-import-owner',
      actual: 1,
      max: 0
    });
  });

  it('fails CLI parsing for unknown flags', () => {
    expect(() => parseArgs(['--typo'])).toThrow('Unknown argument: --typo');
  });

  it('fails CLI parsing when --format is missing a value', () => {
    expect(() => parseArgs(['--format'])).toThrow('--format requires a value');
  });

  it('fails CLI parsing when --output is missing a value', () => {
    expect(() => parseArgs(['--output'])).toThrow('--output requires a value');
  });

  it('fails CLI parsing for unsupported formats', () => {
    expect(() => parseArgs(['--format', 'table'])).toThrow(
      'Unsupported --format table; expected markdown or json'
    );
  });

  it('applies check mode and threshold gates together', () => {
    const rows = [
      classifySourceFile(input({ file: 'src/unknown/unused.ts' })),
      classifySourceFile(input({ retainedSourceImportOwners: ['src/options/utils/index.ts'] }))
    ];

    const result = evaluateNonProductionSourceGates(rows, {
      checkMode: true,
      maxMigrateImportOwner: 0
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'check',
          file: 'src/unknown/unused.ts'
        }),
        expect.objectContaining({
          kind: 'threshold',
          metric: 'migrate-import-owner',
          actual: 1,
          max: 0
        })
      ])
    );
  });

  it('passes check mode for migrate and retain inventory without stop-unknown or delete-now', () => {
    const rows = [
      classifySourceFile(input({ retainedSourceImportOwners: ['src/options/utils/index.ts'] })),
      classifySourceFile(input({ scriptOwners: ['tools/report-ui-architecture-alignment.mjs'] })),
      classifySourceFile(input({ testOwners: ['tests/unit/options/example.test.ts'] })),
      classifySourceFile(
        input({
          productionBuildGraphOwners: ['options/index'],
          productionImportOwners: ['src/options/app/bootstrap.ts']
        })
      ),
      classifySourceFile(
        input({
          file: 'src/ui/domains/theme/index.ts',
          explicitClassificationPatterns: [
            {
              pattern: 'src/ui/domains/theme/index.ts',
              decision: 'retain-production-facade',
              owner: 'theme domain public barrel',
              deletionCondition: 'delete only after public imports move to concrete theme module'
            }
          ]
        })
      )
    ];

    expect(validateNonProductionSourceCheck(rows).ok).toBe(true);
  });

  it('fails check mode for stop-unknown rows', () => {
    const result = validateNonProductionSourceCheck([
      classifySourceFile(input({ file: 'src/unknown/unused.ts' }))
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toContain('stop-unknown');
  });

  it('fails check mode when delete-now coexists with retained import graph owners', () => {
    const result = validateNonProductionSourceCheck([
      {
        file: approvedSectionDependencyDeleteCandidate,
        decision: 'delete-now',
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'empty',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'empty',
          requiredVerification: 'empty'
        },
        retainedSourceImportTargets: ['src/options/utils/defaults.ts']
      }
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toContain('retained source import');
  });

  it('fails check mode for delete-now rows with non-empty owner proofs', () => {
    const result = validateNonProductionSourceCheck([
      {
        file: approvedPostTestDeleteCandidate,
        decision: 'delete-now',
        ownerProofs: {
          productionBuildGraph: 'empty',
          importGraph: 'empty',
          packageBuildScripts: 'owned',
          publicManifestAssets: 'empty',
          testsVisualBrowser: 'owned',
          requiredVerification: 'owned'
        },
        scriptOwners: ['tools/report-ui-architecture-alignment.mjs'],
        testOwners: ['tests/unit/options/widgets/FragmentSettingsWidget.test.ts'],
        requiredVerificationOwners: ['package.json#scripts.quality']
      }
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toContain('packageBuildScripts');
    expect(result.violations[0]?.reason).toContain('testsVisualBrowser');
    expect(result.violations[0]?.reason).toContain('requiredVerification');
  });
});
