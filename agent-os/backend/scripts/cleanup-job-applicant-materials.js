/**
 * Delete generated resume PDFs, cover letters, tailoring notes, and tracker CSVs.
 * Run: node backend/scripts/cleanup-job-applicant-materials.js [--profile banking-svp-cloud-sg]
 */
import { existsSync, readdirSync, rmSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(__dirname, '../data/job-applicant');
const resumesRoot = join(dataRoot, 'resumes');
const spreadsheetsRoot = join(dataRoot, 'spreadsheets');

const profileFilter = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

function deleteFilesInDir(dir, exts) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      n += deleteFilesInDir(p, exts);
      try {
        if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
      } catch (_) {}
    } else if (exts.some((e) => name.toLowerCase().endsWith(e))) {
      unlinkSync(p);
      n++;
      console.log('  deleted', p);
    }
  }
  return n;
}

function cleanupTree(root, exts) {
  if (!existsSync(root)) return 0;
  if (profileFilter) {
    let n = 0;
    for (const ceo of readdirSync(root)) {
      const profileDir = join(root, ceo, profileFilter);
      if (existsSync(profileDir)) n += deleteFilesInDir(profileDir, exts);
    }
    return n;
  }
  return deleteFilesInDir(root, exts);
}

let pdfCount = cleanupTree(resumesRoot, ['.pdf', '.md']);
let csvCount = cleanupTree(spreadsheetsRoot, ['.csv', '.md', '.json']);

console.log(`\nCleanup done: ${pdfCount} resume/cover files, ${csvCount} spreadsheet files removed.`);
