/**
 * Read master resume PDFs and generate tailored resume + cover letter PDFs.
 */
import { createWriteStream, readFileSync, existsSync } from 'fs';
import { dirname, join, extname, resolve, normalize } from 'path';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function materialsRoot() {
  const base = process.env.AGENT_OS_DATA_DIR || join(__dirname, '../../data');
  return join(base, 'job-applicant', 'resumes');
}

/** Resolve cover letter path under materialsRoot. Resume uses master-resume API, not per-job file. */
export function resolveSafeMaterialPath(ceoUserId, profileId, jobId, type) {
  if (type === 'resume' || type === 'resume.pdf') return null;

  const root = normalize(materialsRoot());
  const dir = normalize(join(root, ceoUserId || 'default', profileId || ''));
  if (!dir.startsWith(root)) return null;

  const fileName = `${jobId}-cover-letter.pdf`;
  const abs = normalize(join(dir, fileName));
  if (!abs.startsWith(dir) || !existsSync(abs)) return null;
  return abs;
}

export async function extractPdfText(filePath) {
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`PDF not found: ${filePath}`);
  }
  if (extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error(`Master resume must be a PDF for text extraction: ${filePath}`);
  }
  const { PDFParse } = await import('pdf-parse');
  const buffer = readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result.text || '').trim();
  } finally {
    await parser.destroy();
  }
}

function writePdf({ outputPath, build }) {
  return new Promise((resolvePath, reject) => {
    const doc = new PDFDocument({ margin: 54, size: 'A4' });
    const stream = createWriteStream(outputPath);
    doc.pipe(stream);
    build(doc);
    doc.end();
    stream.on('finish', () => resolvePath(outputPath));
    stream.on('error', reject);
    doc.on('error', reject);
  });
}

export function writeResumePdf({ outputPath, candidateName, job, sections, tailoringNotes }) {
  return writePdf({
    outputPath,
    build(doc) {
      doc.fontSize(18).fillColor('#111').text(candidateName || 'Resume', { align: 'center' });
      if (job?.title && job?.company) {
        doc.fontSize(10).fillColor('#444').text(`Tailored for: ${job.title} — ${job.company}`, { align: 'center' });
      }
      doc.moveDown(0.8);

      for (const section of sections || []) {
        if (section.heading) {
          doc.fontSize(11).fillColor('#222').text(String(section.heading), { underline: true });
          doc.moveDown(0.25);
        }
        doc.fontSize(10).fillColor('#000');
        if (section.content) {
          doc.text(String(section.content), { align: 'left', lineGap: 2 });
          doc.moveDown(0.4);
        }
        if (Array.isArray(section.bullets)) {
          for (const bullet of section.bullets) {
            doc.text(`• ${String(bullet)}`, { indent: 14, lineGap: 1 });
          }
          doc.moveDown(0.4);
        }
      }

      if (tailoringNotes) {
        doc.moveDown(0.5);
        doc.fontSize(8).fillColor('#666').text('Tailoring notes (for CEO review — not part of submitted resume):', {
          underline: true,
        });
        doc.fontSize(8).text(String(tailoringNotes), { lineGap: 1 });
      }
    },
  });
}

export function writeCoverLetterPdf({ outputPath, bodyText, job, candidateName }) {
  const dateStr = new Date().toLocaleDateString('en-SG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return writePdf({
    outputPath,
    build(doc) {
      doc.fontSize(10).fillColor('#000').text(dateStr);
      doc.moveDown(0.6);
      if (job?.company) {
        doc.text(String(job.company));
        doc.moveDown(0.4);
      }
      doc.moveDown(0.6);
      doc.text(String(bodyText || ''), { align: 'left', lineGap: 3 });
      doc.moveDown(1.2);
      if (candidateName) {
        doc.text('Regards,');
        doc.moveDown(0.2);
        doc.text(String(candidateName));
      }
    },
  });
}

export function defaultResumeSections(masterText, tailoringNotes) {
  const summary = (tailoringNotes || masterText || '').slice(0, 1200);
  return [
    { heading: 'Professional Summary', content: summary || '(See master resume — tailoring pending.)' },
    {
      heading: 'Experience highlights',
      bullets: String(tailoringNotes || '')
        .split(/\n/)
        .map((l) => l.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 8),
    },
  ];
}
