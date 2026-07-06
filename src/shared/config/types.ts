/**
 * Configuration type utilities and constraints.
 *
 * This module provides type utilities for configuration management,
 * including readonly constraints and validation helpers.
 */

import type { ReadonlyDeep } from '../types/taxonomy';

// Configuration validation
export interface ConfigValidationError {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly code: string;
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyDeep<ConfigValidationError[]>;
  readonly warnings: ReadonlyDeep<ConfigValidationError[]>;
}

// Configuration metadata
export interface ConfigMetadata {
  readonly version: string;
  readonly lastModified: number;
  readonly source: 'default' | 'user' | 'imported' | 'migrated';
  readonly checksum?: string;
}

// Configuration with metadata
export interface ManagedConfig<T> {
  readonly config: ReadonlyDeep<T>;
  readonly metadata: ReadonlyDeep<ConfigMetadata>;
}

// Configuration change tracking
export interface ConfigChange<T = unknown> {
  readonly path: string;
  readonly oldValue: T;
  readonly newValue: T;
  readonly timestamp: number;
  readonly source: string;
}

export interface ConfigChangeSet {
  readonly changes: ReadonlyDeep<ConfigChange[]>;
  readonly timestamp: number;
  readonly version: string;
}

// Type guards for configuration validation
export function isValidConfigPath(path: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(path);
}

export function isValidConfigValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isValidConfigValue);
  }

  if (type === 'object') {
    return Object.values(value as Record<string, unknown>).every(isValidConfigValue);
  }

  return false;
}

// Configuration merging utilities
export type ConfigMergeStrategy = 'replace' | 'merge' | 'append' | 'prepend';

export interface ConfigMergeOptions {
  readonly strategy: ConfigMergeStrategy;
  readonly arrayMergeStrategy?: 'replace' | 'concat' | 'unique';
  readonly preserveUndefined?: boolean;
}

// Default configuration constraints
export interface DefaultConfigConstraints {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly deprecated: readonly string[];
  readonly validation: ReadonlyDeep<Record<string, (value: unknown) => boolean>>;
}

// Configuration schema
export interface ConfigSchema {
  readonly type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  readonly properties?: ReadonlyDeep<Record<string, ConfigSchema>>;
  readonly items?: ReadonlyDeep<ConfigSchema>;
  readonly required?: readonly string[];
  readonly default?: unknown;
  readonly description?: string;
  readonly examples?: readonly unknown[];
  readonly validation?: (value: unknown) => boolean;
}

// Readonly configuration types for specific domains
export type ReadonlyRestOptions = ReadonlyDeep<{
  baseUrl: string;
  httpsUrl?: string;
  httpUrl?: string;
  vault: string;
  apiKey: string;
}>;

export type ReadonlyTemplateOptions = ReadonlyDeep<{
  article: string;
  fragment: string;
  reading: string;
  ai: string;
}>;

export type ReadonlyAiChatOptions = ReadonlyDeep<{
  includeTimestamps: boolean;
  userName: string;
}>;

export type ReadonlyFragmentClipperOptions = ReadonlyDeep<{
  useFootnoteFormat: boolean;
  captureContext: boolean;
  contextLength: number;
  contextMode: 'chars';
  selectionModifierEnabled: boolean;
  selectionModifierKeys: ('alt' | 'meta' | 'ctrl' | 'shift')[];
  keyboardShortcutsEnabled: boolean;
}>;

export type ReadonlyReadingSessionOptions = ReadonlyDeep<{
  exportMode: 'highlights' | 'full';
  highlightTheme: 'gradient' | 'purple' | 'neonYellow' | 'neonGreen' | 'neonOrange';
}>;

export type ReadonlyVideoOptions = ReadonlyDeep<{
  floatingPromptEnabled: boolean;
  promptButtonLabel: string;
  promptShortcut: string;
  controlBarAutoPause: boolean;
  controlBarScreenshot: boolean;
  commentEditorAutoPause: boolean;
}>;

export type ReadonlyDeepResearchOptions = ReadonlyDeep<{
  pureMode: boolean;
}>;

// Configuration factory functions
export function createConfigMetadata(
  version: string,
  source: ConfigMetadata['source'] = 'default'
): ConfigMetadata {
  return {
    version,
    lastModified: Date.now(),
    source
  };
}

export function createManagedConfig<T>(
  config: T,
  metadata?: Partial<ConfigMetadata>
): ManagedConfig<T> {
  return {
    config: config as ReadonlyDeep<T>,
    metadata: {
      version: '1.0.0',
      lastModified: Date.now(),
      source: 'default',
      ...metadata
    }
  };
}

// Configuration validation helpers
export function validateConfigStructure(
  config: unknown,
  schema: ConfigSchema
): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationError[] = [];

  function validateValue(value: unknown, schema: ConfigSchema, path: string): void {
    if (schema.type === 'object' && schema.properties) {
      if (typeof value !== 'object' || value === null) {
        errors.push({
          path,
          message: `Expected object, got ${typeof value}`,
          severity: 'error',
          code: 'TYPE_MISMATCH'
        });
        return;
      }

      const obj = value as Record<string, unknown>;

      // Check required properties
      if (schema.required) {
        for (const prop of schema.required) {
          if (!(prop in obj)) {
            errors.push({
              path: `${path}.${prop}`,
              message: `Required property '${prop}' is missing`,
              severity: 'error',
              code: 'MISSING_REQUIRED'
            });
          }
        }
      }

      // Validate properties
      for (const [prop, propSchema] of Object.entries(schema.properties)) {
        if (prop in obj) {
          validateValue(obj[prop], propSchema, `${path}.${prop}`);
        }
      }
    }

    // Custom validation
    if (schema.validation && !schema.validation(value)) {
      errors.push({
        path,
        message: 'Custom validation failed',
        severity: 'error',
        code: 'VALIDATION_FAILED'
      });
    }
  }

  validateValue(config, schema, '');

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
