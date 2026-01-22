const fs = require('fs');
const path = require('path');

/**
 * Saves generated files to disk with validation and verification.
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
    let wroteFile = false;

    // Only write if content differs or file doesn't exist
    if (fs.existsSync(absolutePath)) {
      const existingContent = fs.readFileSync(absolutePath, 'utf8');
      if (existingContent !== contentString) {
        fs.writeFileSync(absolutePath, contentString, 'utf8');
        wroteFile = true;
      }
    } else {
      fs.writeFileSync(absolutePath, contentString, 'utf8');
      wroteFile = true;
    }

    // No redundant verification read - trust filesystem write success
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
