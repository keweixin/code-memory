/**
 * Code Memory Graph — Scanner Module
 *
 * Public API for project scanning: file discovery, ignore rules,
 * language detection, and git metadata collection.
 */

export { createIgnoreRule, isIgnored } from './ignore-rules.js';
export { detectLanguage } from './language-detector.js';
export { discoverFiles, type DiscoveredFile, type DiscoverOptions } from './file-discovery.js';
export {
  getGitInfo,
  getFileLastCommit,
  getFileContentHash,
  type GitInfo,
  type CommitInfo,
} from './git-integration.js';
export {
  scanProject,
  type ScanResult,
  type ScanStats,
} from './project-scanner.js';
