import fs from './read-boundary.js';
import path from 'node:path';
import { captureSourceSelection, localExperimentPath, readExperimentFile, sha256, importContext } from './experiment-input.js';

// Prepare evidence, never fabricate a passed test, review or complete build inventory.
export function prepareImports(settingsFile) {
  const root = path.dirname(fs.realpathSync(settingsFile));
  const input = JSON.parse(readExperimentFile(settingsFile, 64 * 1024).toString('utf8'));
  if (input?.schemaVersion !== 1 || input.recipe !== 'lodash-import-scope') throw new Error('Expected schemaVersion 1 lodash-import-scope settings.');
  const output = { schemaVersion: 1, recipe: input.recipe };
  for (const side of ['before', 'after']) {
    const entry = input[side];
    if (!entry || !entry.context || typeof entry.context !== 'object' || Array.isArray(entry.context)) throw new Error(`${side}: build context is required.`);
    const artifact = readExperimentFile(localExperimentPath(root, entry.file), 64 * 1024 * 1024, root);
    if (!artifact.length) throw new Error(`${side}: empty artifact.`);
    const snapshot = captureSourceSelection(root, entry.source);
    output[side] = { file: entry.file, sha256: sha256(artifact), sourceSnapshotHash: snapshot.sha256,
      sourceInventory: { root: snapshot.root, files: snapshot.files }, context: importContext(entry.context) };
  }
  output.verification = { onlyImportChange: false, samePackageVersion: false, behaviorTests: 'not-run', testScope: [] };
  output.preparation = { artifactHashes: 'measured-locally', sourceHashes: 'measured-for-selected-files', sourceCoverage: 'caller-selected; not verified complete', buildContext: 'caller-reported' };
  if (Buffer.byteLength(JSON.stringify(output, null, 2)) > 2 * 1024 * 1024) throw new Error('Prepared manifest exceeds the 2 MiB size limit.');
  return output;
}
