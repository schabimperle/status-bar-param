// Copies all JSON schemas from src/schemas to the requested build directory.
//
// tsc only emits the schemas that the TypeScript actually imports
// (resolveJsonModule). The schemas referenced solely from package.json's
// `jsonValidation` contribution (tasks_launch_schema.json,
// code_workspace_schema.json) are not imported, so without this step they
// would be missing from the packaged .vsix.
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'schemas');
const buildDir = process.argv[2] || 'out';
const outDir = path.join(__dirname, '..', buildDir, 'schemas');

// wipe the destination first so schemas deleted/renamed in src don't linger and
// get packaged from a dirty build tree
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.json')) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  }
}
