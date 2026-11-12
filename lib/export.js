'use strict';

const { titleFromStructure } = require('./structure');
const { stripAiArtifacts } = require('./text-utils');

function cleanForExport(value = '') {
  return stripAiArtifacts(
    value
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\u00a0/g, ' ')
      .trim()
  );
}

function docxParagraph(block) {
  const { Paragraph, TextRun, HeadingLevel } = require('docx');
  const text = cleanForExport(block.text);
  if (!text) return null;

  switch (block.type) {
    case 'title':
      return new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text })],
      });
    case 'subtitle':
      return new Paragraph({
        style: 'Subtitle',
        children: [new TextRun({ text })],
      });
    case 'h1':
      return new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text })],
      });
    case 'h2':
      return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text })],
      });
    case 'h3':
      return new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text })],
      });
    case 'li':
      return new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: text.replace(/^[•\-*–]\s+/, ''), size: 22 })],
      });
    case 'quote':
      return new Paragraph({
        style: 'BlockQuote',
        children: [new TextRun({ text: text.replace(/^>\s?/, '') })],
      });
    default:
      return new Paragraph({
        children: [new TextRun({ text, size: 22 })],
      });
  }
}

async function buildDocx(blocks, { title = 'Document' } = {}) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Footer,
    AlignmentType,
    convertInchesToTwip,
  } = require('docx');
  const children = blocks.map(docxParagraph).filter(Boolean);
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));

  const doc = new Document({
    creator: 'Writing Genie',
    title,
    description: 'Cleaned with Writing Genie',
    styles: {
      default: {
        document: {
          run: { font: 'Georgia', size: 22, color: '242032' },
          paragraph: { spacing: { line: 340, after: 160 } },
        },
      },
      paragraphStyles: [
        {
          id: 'Title',
          name: 'Title',
          basedOn: 'Normal',
          next: 'Subtitle',
          quickFormat: true,
          run: { font: 'Georgia', size: 56, bold: true, color: '191426' },
          paragraph: {
            spacing: { before: 0, after: 200 },
            outlineLevel: 0,
          },
        },
        {
          id: 'Subtitle',
          name: 'Subtitle',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: 'Georgia',
            size: 28,
            italics: true,
            color: '6A6278',
          },
          paragraph: {
            spacing: { before: 0, after: 300 },
            outlineLevel: 1,
          },
        },
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: 'Georgia', size: 34, bold: true, color: '191426' },
          paragraph: {
            spacing: { before: 360, after: 120 },
            keepNext: true,
            outlineLevel: 0,
          },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: 'Georgia', size: 27, bold: true, color: '2B2540' },
          paragraph: {
            spacing: { before: 280, after: 100 },
            keepNext: true,
            outlineLevel: 1,
          },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: 'Georgia',
            size: 23,
            bold: true,
            color: '4A4160',
          },
          paragraph: {
            spacing: { before: 220, after: 80 },
            keepNext: true,
            outlineLevel: 2,
          },
        },
        {
          id: 'BlockQuote',
          name: 'Block Quote',
          basedOn: 'Normal',
          next: 'Normal',
          run: {
            font: 'Georgia',
            size: 22,
            italics: true,
            color: '5B536B',
          },
          paragraph: {
            indent: { left: 720, right: 360 },
            spacing: { before: 100, after: 220 },
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 100 },
                children: [
                  new TextRun({
                    text: 'Writing Genie  ·  cleaned draft',
                    font: 'Georgia',
                    size: 16,
                    color: '948DA3',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function buildPdf(blocks, { title = 'Document' } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 72, right: 72, bottom: 78, left: 72 },
        bufferPages: true,
        info: {
          Title: title,
          Author: 'Writing Genie',
          Creator: 'Writing Genie',
          Producer: 'Writing Genie',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const bottom = () => doc.page.height - doc.page.margins.bottom;
      const ensureSpace = (height) => {
        if (doc.y + height > bottom()) doc.addPage();
      };

      for (const block of blocks) {
        const text = cleanForExport(block.text);
        if (!text) continue;

        switch (block.type) {
          case 'title':
            doc.font('Times-Bold').fontSize(27).fillColor('#191426');
            doc.text(text, { lineGap: 1 });
            doc.moveDown(0.28);
            break;
          case 'subtitle':
            doc.font('Times-Italic').fontSize(14).fillColor('#6A6278');
            doc.text(text, { lineGap: 1 });
            doc.moveDown(0.85);
            break;
          case 'h1':
            ensureSpace(90);
            doc.moveDown(0.55);
            doc.font('Times-Bold').fontSize(18).fillColor('#191426');
            doc.text(text, { lineGap: 1 });
            doc.moveDown(0.32);
            break;
          case 'h2':
            ensureSpace(80);
            doc.moveDown(0.4);
            doc.font('Times-Bold').fontSize(14.5).fillColor('#2B2540');
            doc.text(text, { lineGap: 1 });
            doc.moveDown(0.26);
            break;
          case 'h3':
            ensureSpace(70);
            doc.moveDown(0.3);
            doc.font('Times-Bold').fontSize(12.5).fillColor('#4A4160');
            doc.text(text, { lineGap: 1 });
            doc.moveDown(0.2);
            break;
          case 'li':
            doc.font('Times-Roman').fontSize(11).fillColor('#242032');
            doc.text(`•  ${text.replace(/^[•\-*–]\s+/, '')}`, {
              indent: 10,
              lineGap: 2.4,
              paragraphGap: 3,
            });
            break;
          case 'quote':
            ensureSpace(50);
            doc.moveDown(0.25);
            doc.font('Times-Italic').fontSize(11).fillColor('#5B536B');
            doc.text(text.replace(/^>\s?/, ''), {
              indent: 22,
              lineGap: 2.6,
              paragraphGap: 9,
            });
            doc.moveDown(0.2);
            break;
          default:
            doc.font('Times-Roman').fontSize(11).fillColor('#242032');
            doc.text(text, { lineGap: 3, paragraphGap: 9, align: 'left' });
            break;
        }
      }

      const range = doc.bufferedPageRange();
      for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index);
        const oldBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Times-Roman').fontSize(8.5).fillColor('#948DA3');
        doc.text(
          `Writing Genie  ·  page ${index + 1} of ${range.count}`,
          72,
          doc.page.height - 48,
          { width: doc.page.width - 144, align: 'center', lineBreak: false }
        );
        doc.page.margins.bottom = oldBottom;
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { buildDocx, buildPdf };
