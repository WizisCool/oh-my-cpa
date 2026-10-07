import fs from 'node:fs';

// Artifact damage is a failing evidence verdict, not permission to stop collecting
// the remaining scenarios. Preserve the invalid bytes before recording fresh evidence.
export function appendProbeTiming(filename, record) {
  let timings = [];
  let readError;
  try {
    timings = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(timings)) throw new Error('Probe timings must be an array');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      readError = error;
      try { fs.copyFileSync(filename, `${filename}.invalid`, fs.constants.COPYFILE_EXCL); }
      catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; }
    }
    timings = [];
  }
  timings.push(record);
  fs.writeFileSync(filename, JSON.stringify(timings, null, 2) + '\n');
  return readError;
}
