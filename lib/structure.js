'use strict';

const { splitParagraphs } = require('./text-utils');

const BLOCK_TYPES = new Set(['title', 'subtitle', 'h1', 'h2', 'h3', 'p', 'li', 'quote']);

const KNOWN_SECTIONS = new RegExp(
  '^(abstract|introduction|background|related work|literature review|methodology|methods|' +
    'materials and methods|results|findings|discussion|conclusions?|references|bibliography|' +
    'appendix|executive summary|overview|table of contents|acknowledge?ments?|limitations|' +
    'recommendations|summary|introduction and background|key takeaways|takeaways|next steps)\\b',
  'i'
);

function decodeEntities(value = '') {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripInline(value = '') {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(value) {
  return (value.match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || []).length;
}

function isAllCapsHeading(value) {
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3 || letters.length > 80) return false;
  if (value.length > 90) return false;
  if (wordCount(value) > 12) return false;
  return letters === letters.toUpperCase();
}

function isKnownSection(value) {
  return value.length <= 90 && KNOWN_SECTIONS.test(value.replace(/^[\d.\s]+/, ''));
}

function looksLikeHeading(value) {
  if (value.length > 95) return false;
  if (/[.!?]$/.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 12) return false;
  const meaningful = words.filter(
    (word) => !/^(a|an|the|of|and|or|to|in|on|for|with|by|at|from|as|is|are|be|vs)$/i.test(word)
  );
  if (!meaningful.length) return false;
  const capitalised = meaningful.filter((word) => /^[A-Z0-9“"'(]/.test(word)).length;
  return capitalised / meaningful.length >= 0.6;
}

function normaliseType(type) {
  return BLOCK_TYPES.has(type) ? type : 'p';
}

/** Make sure a document has one title, at most one subtitle, and sensible levels. */
function finalizeStructure(blocks) {
  const cleaned = blocks
    .map((block) => ({ type: normaliseType(block.type), text: (block.text || '').trim() }))
    .filter((block) => block.text);

  let titleUsed = false;
  let subtitleUsed = false;
  const out = [];

  for (let index = 0; index < cleaned.length; index++) {
    let { type, text } = cleaned[index];

    if (type === 'title') {
      if (titleUsed) type = 'h1';
      else titleUsed = true;
    }

    if (type === 'subtitle') {
      if (!titleUsed || subtitleUsed) type = 'p';
      else subtitleUsed = true;
    }

    out.push({ type, text });
  }

  // A first short line is almost always the document title, even if the source
  // styled it as a paragraph.
  if (!titleUsed && out.length) {
    const first = out[0];
    if (
      (first.type === 'p' || first.type === 'h1') &&
      first.text.length <= 130 &&
      wordCount(first.text) <= 18 &&
      !/[.!?]$/.test(first.text)
    ) {
      first.type = 'title';
      titleUsed = true;
    }
  }

  if (!titleUsed && out.length && out[0].type === 'h1' && out[0].text.length <= 120) {
    out[0].type = 'title';
    titleUsed = true;
  }

  return out;
}

/** Extract headings / paragraphs / list items from Mammoth's HTML. */
function htmlToBlocks(html) {
  const blocks = [];
  const re = /<(h[1-6]|p|li|blockquote|td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;

  while ((match = re.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || '';
    const text = stripInline(match[3]);
    if (!text) continue;

    let type = 'p';
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      type = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
      if (/\bclass="[^"]*\btitle\b/i.test(attrs)) type = 'title';
      if (/\bclass="[^"]*\bsubtitle\b/i.test(attrs)) type = 'subtitle';
    } else if (tag === 'li') {
      type = 'li';
    } else if (tag === 'blockquote') {
      type = 'quote';
    } else if (/\bclass="[^"]*\bsubtitle\b/i.test(attrs)) {
      type = 'subtitle';
    } else if (/\bclass="[^"]*\btitle\b/i.test(attrs)) {
      type = 'title';
    }

    blocks.push({ type, text });
  }

  return finalizeStructure(blocks);
}

function splitLinesIntoBlocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());
  const blocks = [];
  let buffer = [];
  let nonEmptySeen = 0;

  const flush = () => {
    const value = buffer.join(' ').trim();
    if (value) blocks.push(value);
    buffer = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) {
      flush();
      continue;
    }

    let next = '';
    for (let lookahead = index + 1; lookahead < lines.length; lookahead++) {
      if (lines[lookahead]) {
        next = lines[lookahead];
        break;
      }
    }

    const endsSentence = /[.!?]$/.test(line);
    const standalone =
      /^#{1,6}\s+/.test(line) ||
      /^[-*•–]\s+/.test(line) ||
      /^>\s?/.test(line) ||
      /^(?:chapter|section|part)\s+[\divxlcdm]+\b/i.test(line) ||
      /^\d+(?:\.\d+){0,3}[.)]?\s+\S/.test(line) ||
      /^by\s+/i.test(line) ||
      isAllCapsHeading(line) ||
      isKnownSection(line) ||
      (nonEmptySeen < 3 && line.length <= 115 && !endsSentence) ||
      (looksLikeHeading(line) &&
        !endsSentence &&
        (!next || /^[A-Z0-9"'“]/.test(next)));

    nonEmptySeen++;

    if (standalone) {
      flush();
      blocks.push(line);
    } else {
      buffer.push(line);
    }
  }

  flush();
  return blocks;
}

/** Infer document structure from plain text, Markdown, or PDF-extracted text. */
function detectStructure(text) {
  const rawBlocks = splitLinesIntoBlocks(text);
  const out = [];
  let titleSeen = false;
  let subtitleSeen = false;
  let h1Seen = false;
  let h2Seen = false;

  for (const raw of rawBlocks) {
    let type = 'p';
    let body = raw;

    const md = raw.match(/^(#{1,6})\s+(.+)$/);
    const bullet = raw.match(/^[-*•–]\s+(.+)$/);
    const quote = raw.match(/^>\s?(.+)$/);
    const numbered = raw.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(.+)$/);
    const chapter = raw.match(/^(?:chapter|section|part)\s+[\divxlcdm]+\b[.:\-–—]?\s*(.*)$/i);

    if (md) {
      body = md[2].trim();
      const level = md[1].length;
      if (level === 1 && out.length === 0 && !titleSeen) {
        type = 'title';
      } else if (level === 1) {
        type = 'h1';
      } else if (level === 2) {
        type = 'h2';
      } else {
        type = 'h3';
      }
    } else if (bullet) {
      body = bullet[1].trim();
      type = 'li';
    } else if (quote) {
      body = quote[1].trim();
      type = 'quote';
    } else if (chapter) {
      body = raw.trim();
      type = h1Seen ? 'h2' : 'h1';
    } else if (numbered && numbered[2].length <= 95 && !/[.!?]$/.test(numbered[2])) {
      body = raw.trim();
      const depth = numbered[1].split('.').length;
      type = depth === 1 ? 'h1' : depth === 2 ? 'h2' : 'h3';
    } else {
      const short = raw.length <= 110 && wordCount(raw) <= 16;
      const endsSentence = /[.!?]$/.test(raw);
      const isFirst = out.length === 0;

      if (isFirst && !endsSentence && raw.length <= 130) {
        type = 'title';
      } else if (
        !subtitleSeen &&
        out.length === 1 &&
        out[0].type === 'title' &&
        short &&
        !endsSentence &&
        !isKnownSection(raw)
      ) {
        type = 'subtitle';
      } else if (isKnownSection(raw)) {
        type = 'h1';
      } else if (/^by\s+/i.test(raw)) {
        type = 'p';
      } else if (isAllCapsHeading(raw)) {
        type = h1Seen ? 'h2' : 'h1';
      } else if (short && !endsSentence && looksLikeHeading(raw)) {
        type = h1Seen ? 'h2' : 'h1';
      }
    }

    body = stripInline(body);
    if (!body) continue;
    if (type === 'title' && titleSeen) type = 'h1';
    if (type === 'subtitle' && (!titleSeen || subtitleSeen)) type = 'p';

    if (type === 'title') titleSeen = true;
    if (type === 'subtitle') subtitleSeen = true;
    if (type === 'h1') h1Seen = true;
    if (type === 'h2') h2Seen = true;

    out.push({ type, text: body });
  }

  return finalizeStructure(out);
}

function structureToText(blocks) {
  return blocks
    .map((block) => {
      if (block.type === 'li') return `• ${block.text}`;
      if (block.type === 'quote') return `> ${block.text}`;
      return block.text;
    })
    .join('\n\n');
}

/**
 * Reuse the original block types when the cleaned text still has the same
 * paragraph count; otherwise infer a fresh structure from the cleaned text.
 */
function resolveStructure(cleanedText, originalStructure) {
  const paragraphs = splitParagraphs(cleanedText)
    .map((paragraph) => paragraph.text.trim())
    .filter(Boolean);

  const original = Array.isArray(originalStructure)
    ? originalStructure
        .filter(
          (block) =>
            block &&
            typeof block.text === 'string' &&
            BLOCK_TYPES.has(block.type) &&
            block.text.trim()
        )
        .slice(0, 4000)
    : [];

  const originalHasHeadings = original.some((block) =>
    ['title', 'subtitle', 'h1', 'h2', 'h3'].includes(block.type)
  );

  if (original.length && original.length === paragraphs.length && originalHasHeadings) {
    return finalizeStructure(
      paragraphs.map((text, index) => ({ type: original[index].type, text }))
    );
  }

  return detectStructure(cleanedText);
}

function titleFromStructure(blocks, fallback = 'Document') {
  const title = blocks.find((block) => block.type === 'title');
  if (title) return title.text;
  const heading = blocks.find((block) => block.type === 'h1');
  return heading ? heading.text : fallback;
}

module.exports = {
  detectStructure,
  htmlToBlocks,
  finalizeStructure,
  resolveStructure,
  structureToText,
  titleFromStructure,
  BLOCK_TYPES,
};
