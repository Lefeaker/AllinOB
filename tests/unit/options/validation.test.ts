import { describe, it, expect } from 'vitest';
import {
  parseClassifierTaxonomy,
  OptionsValidationError,
  validateOptions,
  validateRestOptions,
  validateTemplateOptions
} from '@options/services/validation';
import { getRestDefaults } from '../../utils/restDefaults';

const REST_DEFAULTS = getRestDefaults();
const DEFAULT_BASE_URL = REST_DEFAULTS.httpsUrl.replace(/\/$/, '');
const DEFAULT_HTTP_URL = REST_DEFAULTS.httpUrl.replace(/\/$/, '');

const VALID_TAXONOMY = {
  version: '1.0.0',
  categories: [
    {
      id: 'cat-tech',
      name: 'Tech'
    }
  ],
  tags: [
    {
      id: 'tag-ai',
      name: 'AI'
    }
  ],
  rules: [
    {
      id: 'rule-1',
      name: 'Match AI content',
      conditions: [
        {
          type: 'content',
          operator: 'contains',
          value: 'AI'
        }
      ],
      actions: [
        {
          type: 'assignTag',
          target: 'tags',
          value: 'tag-ai'
        }
      ]
    }
  ]
};

describe('validation', () => {
  describe('parseClassifierTaxonomy', () => {
    it('returns empty object for empty string', () => {
      expect(parseClassifierTaxonomy('')).toEqual({});
      expect(parseClassifierTaxonomy('  ')).toEqual({});
    });

    it('parses valid JSON object', () => {
      const input = JSON.stringify(VALID_TAXONOMY);
      const result = parseClassifierTaxonomy(input);
      expect(result).toEqual(VALID_TAXONOMY);
    });

    it('throws OptionsValidationError for empty JSON object', () => {
      const input = '{}';
      expect(() => parseClassifierTaxonomy(input)).toThrow(OptionsValidationError);
    });

    it('throws OptionsValidationError with detail for invalid JSON syntax', () => {
      const input = '{invalid json}';
      expect(() => parseClassifierTaxonomy(input)).toThrow(OptionsValidationError);

      try {
        parseClassifierTaxonomy(input);
      } catch (error) {
        expect(error).toBeInstanceOf(OptionsValidationError);
        if (error instanceof OptionsValidationError) {
          expect(error.code).toBe('INVALID_TAXONOMY');
          expect(error.detail).toBeDefined();
        }
      }
    });

    it('throws OptionsValidationError with issues for invalid taxonomy structure', () => {
      const input = '{"valid": "taxonomy"}';
      expect(() => parseClassifierTaxonomy(input)).toThrow(OptionsValidationError);
    });
  });

  describe('validateOptions', () => {
    it('validates valid StoredOptions', () => {
      const options = {
        rest: {
          baseUrl: DEFAULT_BASE_URL,
          vault: 'MyVault',
          apiKey: '1234567890'
        },
        templates: {
          article: 'path/to/article',
          fragment: 'path/to/fragment'
        }
      };

      const result = validateOptions(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rest).toEqual(options.rest);
        expect(result.data.templates).toEqual(options.templates);
      }
    });

    it('allows extra fields in StoredOptions', () => {
      const options = {
        rest: {
          baseUrl: DEFAULT_BASE_URL,
          vault: 'MyVault',
          apiKey: '1234567890'
        },
        customField: 'custom value'
      };

      const result = validateOptions(options);
      expect(result.success).toBe(true);
    });

    it('strips legacy rest rootDir from stored options while preserving current fields', () => {
      const options = {
        rest: {
          baseUrl: DEFAULT_BASE_URL,
          vault: 'MyVault',
          apiKey: '1234567890',
          rootDir: 'Notes',
          localFolderId: 'folder-id',
          localFolderName: 'Local Folder'
        },
        aiChat: {
          includeTimestamps: true,
          userName: 'TestUser'
        }
      };

      const result = validateOptions(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rest).not.toHaveProperty('rootDir');
        expect(result.data.rest?.localFolderId).toBe('folder-id');
        expect(result.data.rest?.localFolderName).toBe('Local Folder');
      }
    });

    it('fails validation for invalid data', () => {
      const result = validateOptions('not an object');
      expect(result.success).toBe(false);
    });
  });

  describe('validateRestOptions', () => {
    it('validates valid REST options', () => {
      const options = {
        baseUrl: DEFAULT_BASE_URL,
        vault: 'MyVault',
        apiKey: '1234567890'
      };

      const result = validateRestOptions(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(options);
      }
    });

    it('strips legacy rootDir from REST options while preserving current optional fields', () => {
      const options = {
        baseUrl: DEFAULT_BASE_URL,
        httpsUrl: DEFAULT_BASE_URL,
        httpUrl: DEFAULT_HTTP_URL,
        vault: 'MyVault',
        apiKey: '1234567890',
        rootDir: 'Notes',
        localFolderId: 'folder-id',
        localFolderName: 'Local Folder'
      };

      const result = validateRestOptions(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('rootDir');
        expect(result.data.localFolderId).toBe('folder-id');
        expect(result.data.localFolderName).toBe('Local Folder');
      }
    });

    it('fails validation for invalid baseUrl', () => {
      const options = {
        baseUrl: 'not a valid url',
        vault: 'MyVault',
        apiKey: '1234567890'
      };

      const result = validateRestOptions(options);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('baseUrl');
        expect(result.error.issues[0]?.message).toBe('Must be a valid URL');
        expect(result.error.issues[0]?.message).not.toMatch(/[\u4e00-\u9fff]/u);
      }
    });

    it('fails validation for empty vault name', () => {
      const options = {
        baseUrl: DEFAULT_BASE_URL,
        vault: '',
        apiKey: '1234567890'
      };

      const result = validateRestOptions(options);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('vault');
        expect(result.error.issues[0]?.message).toBe('Vault name is required');
        expect(result.error.issues[0]?.message).not.toMatch(/[\u4e00-\u9fff]/u);
      }
    });

    it('fails validation for short API key', () => {
      const options = {
        baseUrl: DEFAULT_BASE_URL,
        vault: 'MyVault',
        apiKey: 'short'
      };

      const result = validateRestOptions(options);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('apiKey');
        expect(result.error.issues[0]?.message).toBe('API key must be at least 10 characters');
        expect(result.error.issues[0]?.message).not.toMatch(/[\u4e00-\u9fff]/u);
      }
    });

    it('fails validation for missing required fields', () => {
      const options = {
        baseUrl: DEFAULT_BASE_URL
      };

      const result = validateRestOptions(options);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('validateTemplateOptions', () => {
    it('validates valid template options', () => {
      const options = {
        article: 'path/to/article',
        video: 'path/to/video',
        fragment: 'path/to/fragment',
        reading: 'path/to/reading',
        ai: 'path/to/ai'
      };

      const result = validateTemplateOptions(options);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(options);
      }
    });

    it('fails validation for missing required fields', () => {
      const options = {
        article: 'path/to/article',
        fragment: 'path/to/fragment'
      };

      const result = validateTemplateOptions(options);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });

    it('fails validation for invalid data type', () => {
      const options = {
        article: 123,
        video: 'path/to/video',
        fragment: 'path/to/fragment',
        reading: 'path/to/reading',
        ai: 'path/to/ai'
      };

      const result = validateTemplateOptions(options);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('article');
      }
    });
  });
});
