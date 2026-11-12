'use strict';

const path = require('path');
const {
  detectStructure,
  htmlToBlocks,
  structureToText,
} = require('./structure');

class ExtractError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function weightedMedian(items) {
  if (!items.length) return 11;
  const sorted = [...items].sort((a, b) => a.size - b.size);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let running = 0;
  for (const item of sorted) {
    running += item.weight;
    if (running >= total / 2) return item.size;
  }
  return sorted[sorted.length - 1].size;
}

function groupLines(items) {
  const sorted = items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({ ...item, y: Number(item.y) || 0, x: Number(item.x) || 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  let current = null;

  for (const item of sorted) {
    if (!current || Math.abs(current.y - item.y) > 2.5) {
      if (current) lines.push(current);
      current = {
        y: item.y,
        x: item.x,
        fontSize: item.fontSize || 11,
        height: item.height || item.fontSize || 11,
        parts: [item.str],
      };
    } else {
      current.parts.push(item.str);
      current.x = Math.min(current.x, item.x);
      current.fontSize = Math.max(current.fontSize, item.fontSize || 11);
      current.height = Math.max(current.height, item.height || 0);
    }
  }
  if (current) lines.push(current);

  return lines.map((line) => ({
    text: line.parts.join(' ').replace(/\s+/g, ' ').trim(),
    y: line.y,
    x: line.x,
    fontSize: line.fontSize,
    height: line.height,
  })).filter((line) => line.text);
}

/**
 * Rebuild paragraphs from positioned PDF text items. This keeps headings on
 * their own lines and inserts blank lines at real paragraph gaps, which the
 * structure detector then uses for title/heading inference.
 */
async function extractPdfText(buffer) {
  const { extractTextItems } = require('unpdf');
  let pages;
  try {
    const result = await extractTextItems(new Uint8Array(buffer));
    pages = Array.isArray(result.items?.[0]) ? result.items : [result.items || []];
  } catch {
    throw new ExtractError('That PDF could not be read. It may be encrypted or damaged.');
  }

  const lines = [];
  for (const page of pages) {
    for (const line of groupLines(page)) {
      // Skip page footers and page numbers.
      if (
        line.y < 60 &&
        (/writing genie/i.test(line.text) ||
          /^page\s+\d+/i.test(line.text) ||
          /^\d{1,3}$/.test(line.text))
      ) {
        continue;
      }
      lines.push(line);
    }
  }

  if (!lines.length) return '';

  const bodySize = weightedMedian(
    lines.map((line) => ({ size: line.fontSize, weight: Math.max(1, line.text.length) }))
  );

  const blocks = [];
  let paragraph = [];
  let previous = null;

  const flush = () => {
    const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
    paragraph = [];
  };

  for (const line of lines) {
    const isBullet = /^[-*•–]\s+/.test(line.text);
    const isHeading =
      line.fontSize >= bodySize * 1.2 &&
      line.text.length <= 120 &&
      !/[.!?]$/.test(line.text);
    const gapBreak =
      previous &&
      previous.y - line.y >
        Math.max(previous.height || 0, line.height || 0, bodySize) * 1.75 + 2;
    const indentBreak = previous && Math.abs(previous.x - line.x) > 8;
    const wasHeading = previous && (previous.isHeading || previous.isBullet);

    if (gapBreak || indentBreak || isHeading || isBullet || wasHeading) flush();

    paragraph.push(line.text);

    if (isHeading || isBullet) flush();

    previous = { ...line, isHeading, isBullet };
  }
  flush();

  return blocks.join('\n\n');
}

async function extractText({ buffer, originalname = '', mimetype = '' }) {
  if (!buffer || !buffer.length) throw new ExtractError('That file appears to be empty.');
  if (buffer.length > 12 * 1024 * 1024) {
    throw new ExtractError('Files must be smaller than 12 MB.');
  }

  const ext = path.extname(originalname).toLowerCase();
  let text = '';
  let format = '';
  let structure = [];

  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.convertToHtml(
        { buffer },
        {
          styleMap: [
            "p[style-name='Title'] => h1.title:fresh",
            "p[style-name='Subtitle'] => p.subtitle:fresh",
            "p[style-name='Block Quote'] => blockquote:fresh",
          ],
        }
      );
      structure = htmlToBlocks(result.value || '');
      if (structure.length) {
        text = structureToText(structure);
      } else {
        const fallback = await mammoth.extractRawText({ buffer });
        text = fallback.value || '';
        structure = detectStructure(text);
      }
      format = 'Word document';
    } catch {
      throw new ExtractError('That .docx file could not be read. Try re-saving it from Word.');
    }
  } else if (ext === '.pdf' || mimetype === 'application/pdf') {
    text = await extractPdfText(buffer);
    structure = detectStructure(text);
    format = 'PDF';
  } else if (ext === '.txt' || ext === '.md' || ext === '.rtf' || mimetype.startsWith('text/')) {
    if (ext === '.rtf') {
      text = buffer
        .toString('utf8')
        .replace(/\\par[d]?/g, '\n')
        .replace(/\{\\[^}]+\}/g, '')
        .replace(/\\[a-z]+\d* ?/gi, '')
        .replace(/[{}]/g, '');
    } else {
      text = buffer.toString('utf8');
    }
    text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
    structure = detectStructure(text);
    format = ext === '.md' ? 'Markdown file' : 'Text file';
  } else if (ext === '.doc') {
    throw new ExtractError('Legacy .doc files are not supported. Save it as .docx or PDF first.');
  } else {
    throw new ExtractError('Upload a .docx, .pdf, .txt, or .md file.');
  }

  text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');

  if (!text.trim() || text.replace(/\s/g, '').length < 20) {
    throw new ExtractError(
      ext === '.pdf'
        ? 'This PDF looks like a scan with no selectable text. Try a text-based PDF or paste the text instead.'
        : 'No readable text was found in that file.'
    );
  }

  return {
    text: text.trim(),
    filename: originalname || 'pasted-text.txt',
    format,
    characters: text.length,
    structure,
  };
}

module.exports = { extractText, ExtractError };
