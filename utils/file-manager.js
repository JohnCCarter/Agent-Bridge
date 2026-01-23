const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cache of file content hashes to avoid redundant reads
const fileHashCache = new Map();

/**
 * Computes a fast hash of file content for change detection.
 * @param {string} content - File content string
 * @returns {string} Hash digest
 */
function hashContent(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Saves generated files to disk with validation and optimized change detection.
 * @param {Array<{path: string, content: string|Buffer}>} files - Array of file objects to save
 * @returns {Array<string>} Array of relative paths for persisted files
 */
function saveGeneratedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const persistedPaths = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
      throw new Error('Generated file entry is missing a valid path.');
    }

    if (file.content === undefined) {
      throw new Error(`Generated file ${file.path} is missing content.`);
    }

    const absolutePath = path.isAbsolute(file.path)
      ? file.path
      : path.join(process.cwd(), file.path);

    const directory = path.dirname(absolutePath);
    fs.mkdirSync(directory, { recursive: true });

    const rawContent = file.content;
    const contentString = Buffer.isBuffer(rawContent) ? rawContent.toString('utf8') : String(rawContent);
    const newHash = hashContent(contentString);
    let wroteFile = false;

    // Optimized change detection using hash cache
    const fileExists = fs.existsSync(absolutePath);
    const cachedHash = fileHashCache.get(absolutePath);
    
    if (fileExists && cachedHash === newHash) {
      // File unchanged - skip write
      wroteFile = false;
    } else if (fileExists && !cachedHash) {
      // File exists but not in cache - read and compare once
      const existingContent = fs.readFileSync(absolutePath, 'utf8');
      const existingHash = hashContent(existingContent);
      
      if (existingHash !== newHash) {
        fs.writeFileSync(absolutePath, contentString, 'utf8');
        wroteFile = true;
        fileHashCache.set(absolutePath, newHash);
      } else {
        fileHashCache.set(absolutePath, newHash);
        wroteFile = false;
      }
    } else {
      // File doesn't exist - write it
      fs.writeFileSync(absolutePath, contentString, 'utf8');
      wroteFile = true;
      fileHashCache.set(absolutePath, newHash);
    }

    const relativePath = path.relative(process.cwd(), absolutePath) || absolutePath;
    const status = wroteFile ? 'written' : 'already up-to-date';
    console.log(`   Generated file ${status}: ${relativePath}`);
    persistedPaths.push(relativePath);
  }

  return persistedPaths;
}

module.exports = {
  saveGeneratedFiles
};
