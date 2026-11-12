'use strict';

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves`.split(/\s+/));

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'fig', 'al', 'inc', 'ltd', 'co', 'no', 'vol', 'pp', 'cf', 'approx', 'dept',
  'est', 'min', 'max', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'a.m', 'p.m'
]);

/** Normalise line endings, trim, collapse excess blank lines. */
function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * PDF extraction hard-wraps lines. Join a line with the next one when the
 * previous line does not end a sentence and the next line does not look like
 * a list item or heading.
 */
function unwrapHardLines(text) {
  return text
    .split('\n')
    .reduce((out, line) => {
      if (!out.length) return [line];
      const prev = out[out.length - 1];
      const prevEnds = /[.!?:;)"'”’]$/.test(prev.trim());
      const isBlank = !prev.trim() || !line.trim();
      const nextIsListItem = /^\s*(?:[-*•–]|\d+[.)]|[A-Z][A-Z\s]{3,}$)/.test(line);
      const prevIsShort = prev.trim().length < 45;
      if (!prevEnds && !isBlank && !nextIsListItem && !prevIsShort) {
        out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + line.trim();
        return out;
      }
      out.push(line);
      return out;
    }, [])
    .join('\n');
}

/** Split into paragraph blocks, preserving each block's absolute offset. */
function splitParagraphs(text) {
  const paragraphs = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const body = raw.replace(/\n/g, ' ');
    const leading = body.length - body.trimStart().length;
    const trimmed = body.trim();
    if (!trimmed) continue;
    paragraphs.push({
      text: trimmed,
      start: m.index + leading,
      end: m.index + leading + trimmed.length,
    });
  }
  return paragraphs;
}

/**
 * Sentence segmentation that copes with abbreviations, decimals and quotes.
 * Offsets are absolute within the input text.
 */
function splitSentences(text, paragraphStart = 0) {
  const out = [];
  let start = 0;

  const push = (s, e) => {
    const slice = text.slice(s, e);
    const lead = slice.length - slice.trimStart().length;
    const trail = slice.length - slice.trimEnd().length;
    const body = slice.trim();
    if (!body) return;
    if (body.replace(/[^A-Za-z0-9]/g, '').length === 0) return;
    out.push({
      text: body,
      start: paragraphStart + s + lead,
      end: paragraphStart + e - trail,
    });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    let j = i + 1;
    while (j < text.length && /["'”’)\]]/.test(text[j])) j++;

    // Must be followed by whitespace or end of paragraph.
    if (j < text.length && !/\s/.test(text[j])) {
      i = j - 1;
      continue;
    }
    if (ch === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue;

    const before = text.slice(start, i);
    const lastWord = (before.match(/([A-Za-z][A-Za-z.]*)$/) || [])[1] || '';
    if (ch === '.' && ABBREVIATIONS.has(lastWord.toLowerCase().replace(/\.+$/, ''))) continue;
    // Initials such as "J. K. Rowling"
    if (ch === '.' && /(?:^|\s)[A-Z]$/.test(before)) continue;
    if (ch === '.' && lastWord.length === 1 && /[A-Z]/.test(lastWord)) continue;

    push(start, j);
    start = j;
    while (start < text.length && /\s/.test(text[start])) start++;
    i = start - 1;
  }
  push(start, text.length);
  return out;
}

/** All sentences of the document with paragraph index. */
function documentSentences(text) {
  const paragraphs = splitParagraphs(text);
  const sentences = [];
  paragraphs.forEach((p, pIdx) => {
    splitSentences(p.text, p.start).forEach((s, sIdx) =>
      sentences.push({ ...s, paragraph: pIdx, indexInParagraph: sIdx })
    );
  });
  return { paragraphs, sentences };
}

function words(text) {
  return (text.match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || []);
}

function contentWords(text) {
  return words(text)
    .map((w) => w.toLowerCase().replace(/['’]s$/, ''))
    .filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

/** Tokenise with character offsets, useful for fuzzy source matching. */
function tokenizeWithOffsets(text) {
  const tokens = [];
  const re = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({
      value: m[0].toLowerCase().replace(/['’]s$/, ''),
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }
  return tokens;
}

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function readability(text) {
  const w = words(text);
  const s = splitSentences(text).length || 1;
  if (!w.length) return { flesch: 0, grade: 0 };
  const syl = w.reduce((sum, word) => sum + syllables(word), 0);
  const flesch = 206.835 - 1.015 * (w.length / s) - 84.6 * (syl / w.length);
  const grade = 0.39 * (w.length / s) + 11.8 * (syl / w.length) - 15.59;
  return {
    flesch: Math.max(0, Math.min(100, Math.round(flesch))),
    grade: Math.max(1, Math.min(20, Math.round(grade))),
  };
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove Markdown-style artifacts and dash characters that make text look
 * machine-generated. Used on analyzed text, rewritten text and exports.
 */
function stripAiArtifacts(text) {
  if (!text) return '';

  let out = String(text);

  // Markdown heading markers at the start of a line, e.g. "## Overview".
  out = out.replace(/^[\t ]{0,3}#{1,6}[\t ]+/gm, '');

  // Emphasis and code markers, keeping the words inside.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
  out = out.replace(/__([^_\n]+)__/g, '$1');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  out = out.replace(/~~([^~\n]+)~~/g, '$1');

  // Any leftover hashes or asterisks.
  out = out.replace(/[#*]/g, '');

  // Em dashes and en dashes become normal punctuation.
  out = out.replace(/\s*[—–]\s*/g, (match, offset, whole) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + match.length);

    if (!before.trim() || !after.trim()) return ' ';
    if (/\d\s*$/.test(before) && /^\s*\d/.test(after)) return '-';
    if (
      /^\s*(it|this|that|they|we|you|he|she|there|these|those)\b/i.test(after) &&
      !/[.!?]\s*$/.test(before)
    ) {
      return '. ';
    }
    return ', ';
  });

  // Tidy punctuation and spacing left behind by the replacements.
  out = out
    .replace(/,\s*,+/g, ',')
    .replace(/,\s*([.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/(^|[.!?]\s+)([a-z])/g, (match, prefix, letter) => prefix + letter.toUpperCase());

  return out.trim();
}

/** Longest common contiguous token sequence between two token arrays. */
function longestCommonRun(aTokens, bTokens) {
  const n = aTokens.length;
  const m = bTokens.length;
  if (!n || !m) return { length: 0, aStart: 0, bStart: 0 };
  let prev = new Uint16Array(m + 1);
  let curr = new Uint16Array(m + 1);
  let best = 0;
  let bestA = 0;
  let bestB = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (aTokens[i - 1] === bTokens[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) {
          best = curr[j];
          bestA = i - best;
          bestB = j - best;
        }
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return { length: best, aStart: bestA, bStart: bestB };
}

module.exports = {
  STOPWORDS,
  normalizeText,
  unwrapHardLines,
  splitParagraphs,
  splitSentences,
  documentSentences,
  words,
  contentWords,
  tokenizeWithOffsets,
  readability,
  stdDev,
  clamp,
  escapeRegExp,
  longestCommonRun,
  syllables,
  stripAiArtifacts,
};
