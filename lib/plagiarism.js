'use strict';

const {
  documentSentences,
  words,
  tokenizeWithOffsets,
  longestCommonRun,
  clamp,
} = require('./text-utils');

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const OPENALEX_API = 'https://api.openalex.org/works';
const USER_AGENT = 'WritingGenie/1.0 (local writing assistant)';
const MAX_CANDIDATES = 3;
const TIMEOUT_MS = 8000;

/** Widely quoted passages used for an offline reference pass. */
const KNOWN_QUOTES = [
  {
    text: 'To be, or not to be, that is the question',
    author: 'William Shakespeare, Hamlet',
    url: 'https://en.wikipedia.org/wiki/To_be,_or_not_to_be',
  },
  {
    text: 'I have a dream that one day this nation will rise up and live out the true meaning of its creed',
    author: 'Martin Luther King Jr., 1963',
    url: 'https://en.wikipedia.org/wiki/I_Have_a_Dream',
  },
  {
    text: 'Ask not what your country can do for you, ask what you can do for your country',
    author: 'John F. Kennedy, 1961',
    url: 'https://en.wikipedia.org/wiki/Inaugural_address_of_John_F._Kennedy',
  },
  {
    text: 'The only thing we have to fear is fear itself',
    author: 'Franklin D. Roosevelt, 1933',
    url: 'https://en.wikipedia.org/wiki/First_inaugural_address_of_Franklin_D._Roosevelt',
  },
  {
    text: 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness',
    author: 'Charles Dickens, A Tale of Two Cities',
    url: 'https://en.wikipedia.org/wiki/A_Tale_of_Two_Cities',
  },
  {
    text: 'All animals are equal, but some animals are more equal than others',
    author: 'George Orwell, Animal Farm',
    url: 'https://en.wikipedia.org/wiki/Animal_Farm',
  },
  {
    text: 'We hold these truths to be self-evident, that all men are created equal',
    author: 'United States Declaration of Independence',
    url: 'https://en.wikipedia.org/wiki/United_States_Declaration_of_Independence',
  },
  {
    text: 'Two roads diverged in a wood, and I, I took the one less traveled by, and that has made all the difference',
    author: 'Robert Frost, The Road Not Taken',
    url: 'https://en.wikipedia.org/wiki/The_Road_Not_Taken',
  },
  {
    text: 'All happy families are alike; each unhappy family is unhappy in its own way',
    author: 'Leo Tolstoy, Anna Karenina',
    url: 'https://en.wikipedia.org/wiki/Anna_Karenina',
  },
  {
    text: 'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife',
    author: 'Jane Austen, Pride and Prejudice',
    url: 'https://en.wikipedia.org/wiki/Pride_and_Prejudice',
  },
  {
    text: 'In the beginning God created the heavens and the earth',
    author: 'Genesis 1:1',
    url: 'https://en.wikipedia.org/wiki/Genesis_creation_narrative',
  },
  {
    text: 'The unexamined life is not worth living',
    author: 'Socrates, Apology',
    url: 'https://en.wikipedia.org/wiki/Apology_(Plato)',
  },
];

function stripHtml(value = '') {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function normaliseTitle(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Reference service returned ${res.status}`);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Reference service is rate-limiting requests — try again in a moment');
  }
}

/**
 * Compare one document sentence against a block of reference text and return
 * the longest shared word run, mapped back to document offsets.
 */
function compareToSource(sentence, sourceText, sourceTokens) {
  const sTokens = tokenizeWithOffsets(sentence.text);
  const values = sTokens.map((t) => t.value);
  const run = longestCommonRun(values, sourceTokens.map((t) => t.value));

  if (run.length < 8) return null;
  const ratio = run.length / Math.max(1, values.length);
  if (ratio < 0.22) return null;

  const docStartToken = sTokens[run.aStart];
  const docEndToken = sTokens[run.aStart + run.length - 1];
  if (!docStartToken || !docEndToken) return null;

  const sourceStart = sourceTokens[run.bStart]?.start ?? 0;
  const snippetStart = Math.max(0, sourceStart - 70);
  return {
    start: sentence.start + docStartToken.start,
    end: sentence.start + docEndToken.end,
    matchedWords: run.length,
    similarity: Math.round(ratio * 100),
    matchedText: sentence.text.slice(docStartToken.start, docEndToken.end),
    sourceSnippet: sourceText.slice(snippetStart, sourceStart + 220).trim(),
  };
}

async function scanWikipedia(sentence, index) {
  const tokens = words(sentence.text);
  if (tokens.length < 8) return null;

  const query = tokens.slice(0, 10).join(' ');
  const searchUrl =
    `${WIKI_API}?action=query&list=search&format=json&srlimit=1&srprop=snippet` +
    `&srsearch=${encodeURIComponent(`"${query}"`)}`;

  const search = await fetchJson(searchUrl);
  const hit = search?.query?.search?.[0];
  if (!hit) return null;

  // Pull the plain-text page so the comparison is not limited to the snippet.
  const extractUrl =
    `${WIKI_API}?action=query&prop=extracts&explaintext=1&format=json` +
    `&pageids=${hit.pageid}`;
  const page = await fetchJson(extractUrl);
  const pageData = page?.query?.pages?.[hit.pageid];
  const rawSource = pageData?.extract || stripHtml(hit.snippet || '');
  const sourceText = rawSource.slice(0, 80000);

  const sourceTokens = tokenizeWithOffsets(sourceText);
  const comparison = compareToSource(sentence, sourceText, sourceTokens);

  if (!comparison) {
    // The snippet still proves a phrase-level overlap exists.
    const snippet = stripHtml(hit.snippet || '');
    const snippetTokens = tokenizeWithOffsets(snippet);
    const run = longestCommonRun(tokens.map((t) => t.toLowerCase()), snippetTokens.map((t) => t.value));
    if (run.length < 7) return null;
    const sTokens = tokenizeWithOffsets(sentence.text);
    const startT = sTokens[run.aStart];
    const endT = sTokens[run.aStart + run.length - 1];
    if (!startT || !endT) return null;
    return {
      sentenceIndex: index,
      sentenceText: sentence.text,
      start: sentence.start + startT.start,
      end: sentence.start + endT.end,
      matchedText: sentence.text.slice(startT.start, endT.end),
      matchedWords: run.length,
      similarity: Math.round((run.length / Math.max(1, tokens.length)) * 100),
      source: {
        title: normaliseTitle(hit.title),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
        kind: 'wikipedia',
        snippet: snippet.slice(0, 220),
      },
    };
  }

  return {
    sentenceIndex: index,
    sentenceText: sentence.text,
    ...comparison,
    source: {
      title: normaliseTitle(hit.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      kind: 'wikipedia',
      snippet: comparison.sourceSnippet,
    },
  };
}

/** Turn OpenAlex's inverted abstract index back into readable text. */
function abstractFromInverted(index) {
  if (!index || typeof index !== 'object') return '';
  const slots = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) slots[position] = word;
  }
  return slots.filter(Boolean).join(' ');
}

async function scanOpenAlex(sentence, index) {
  const tokens = words(sentence.text);
  if (tokens.length < 8) return null;

  const query = tokens.slice(0, 12).join(' ');
  const url =
    `${OPENALEX_API}?search=${encodeURIComponent(`"${query}"`)}` +
    `&per-page=3&select=id,title,publication_year,doi,abstract_inverted_index` +
    `&mailto=writing-genie@example.com`;

  const data = await fetchJson(url);
  let best = null;

  for (const work of data?.results || []) {
    const abstract = abstractFromInverted(work.abstract_inverted_index);
    const sourceText = `${work.title || ''}. ${abstract}`.trim();
    if (!sourceText) continue;
    const comparison = compareToSource(sentence, sourceText, tokenizeWithOffsets(sourceText));
    if (!comparison) continue;
    const candidate = {
      sentenceIndex: index,
      sentenceText: sentence.text,
      ...comparison,
      source: {
        title: work.title || 'Academic paper',
        url: work.doi ? `https://doi.org/${work.doi.replace(/^https?:\/\/doi\.org\//, '')}` : work.id,
        kind: 'academic',
        snippet: `${comparison.sourceSnippet}${work.publication_year ? ` (${work.publication_year})` : ''}`,
      },
    };
    if (!best || candidate.similarity > best.similarity) best = candidate;
  }

  return best;
}

/** Local reference pass: famous quotations and internal repetition. */
function scanLocal(text, sentences) {
  const matches = [];
  const allTokens = tokenizeWithOffsets(text);

  for (const quote of KNOWN_QUOTES) {
    const sourceText = quote.text;
    const quoteTokens = tokenizeWithOffsets(sourceText);
    const run = longestCommonRun(
      allTokens.map((t) => t.value),
      quoteTokens.map((t) => t.value)
    );
    if (run.length < 8) continue;
    const ratio = run.length / Math.max(1, quoteTokens.length);
    if (ratio < 0.3) continue;
    const startT = allTokens[run.aStart];
    const endT = allTokens[run.aStart + run.length - 1];
    if (!startT || !endT) continue;
    matches.push({
      sentenceIndex: findSentenceIndex(sentences, startT.start),
      sentenceText: sentences[findSentenceIndex(sentences, startT.start)]?.text || '',
      start: startT.start,
      end: endT.end,
      matchedText: text.slice(startT.start, endT.end),
      matchedWords: run.length,
      similarity: Math.round(Math.min(1, ratio) * 100),
      source: {
        title: quote.author,
        url: quote.url,
        kind: 'quotation',
        snippet: quote.text,
      },
    });
  }

  // Near-duplicate sentences inside the same document.
  const fingerprint = (sentence) => {
    const values = words(sentence.text).map((w) => w.toLowerCase());
    if (values.length < 9) return null;
    return new Set(Array.from({ length: values.length - 7 }, (_, i) => values.slice(i, i + 8).join(' ')));
  };

  const prints = sentences.map(fingerprint);
  for (let i = 0; i < prints.length; i++) {
    if (!prints[i]) continue;
    for (let j = i + 1; j < prints.length; j++) {
      if (!prints[j]) continue;
      let shared = 0;
      for (const shingle of prints[i]) if (prints[j].has(shingle)) shared++;
      const smaller = Math.min(prints[i].size, prints[j].size);
      const overlap = smaller ? shared / smaller : 0;
      if (overlap >= 0.6) {
        matches.push({
          sentenceIndex: j,
          sentenceText: sentences[j].text,
          start: sentences[j].start,
          end: sentences[j].end,
          matchedText: sentences[j].text,
          matchedWords: words(sentences[j].text).length,
          similarity: Math.round(overlap * 100),
          source: {
            title: 'Repeated passage in this document',
            url: null,
            kind: 'internal',
            snippet: sentences[i].text.slice(0, 220),
          },
        });
        break;
      }
    }
  }

  return matches;
}

function findSentenceIndex(sentences, offset) {
  const idx = sentences.findIndex((s) => offset >= s.start && offset < s.end);
  return idx === -1 ? 0 : idx;
}

/** Pick long, relevant sentences spread across the whole document. */
function pickSpreadCandidates(sentences, limit) {
  const usable = sentences
    .map((sentence, index) => ({ sentence, index, len: words(sentence.text).length }))
    .filter((candidate) => candidate.len >= 12);

  if (!usable.length) return [];
  const bucketCount = Math.min(limit, usable.length);
  const picked = [];

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const from = Math.floor((bucket * usable.length) / bucketCount);
    const to = Math.floor(((bucket + 1) * usable.length) / bucketCount);
    const group = usable.slice(from, to).sort((a, b) => b.len - a.len);
    if (group[0]) picked.push(group[0]);
  }

  return picked;
}

/**
 * Check a spread sample of sentences against Wikipedia and OpenAlex.
 * Exported so large-document processing can scan one merged sample.
 */
async function scanPublicSources(text, limit = MAX_CANDIDATES) {
  const { sentences } = documentSentences(text);
  const candidates = pickSpreadCandidates(sentences, limit);
  const matches = [];
  let onlineUsed = false;
  let onlineError = null;
  let queried = false;

  for (const candidate of candidates) {
    let matched = false;

    try {
      const result = await scanWikipedia(candidate.sentence, candidate.index);
      queried = true;
      if (result) {
        matched = true;
        matches.push(result);
      }
    } catch (error) {
      onlineError =
        error?.name === 'TimeoutError'
          ? 'Reference lookup timed out'
          : error?.message || 'Reference lookup unavailable';
    }

    // Academic abstracts are a useful second opinion, especially when the
    // Wikipedia endpoint is rate-limiting us.
    if (!matched) {
      try {
        const result = await scanOpenAlex(candidate.sentence, candidate.index);
        queried = true;
        if (result) matches.push(result);
      } catch (error) {
        onlineError = onlineError || error?.message || 'Academic lookup unavailable';
      }
    }

    // Be polite to the public APIs between lookups.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  onlineUsed = queried;

  // Keep the strongest non-overlapping match for any span.
  matches.sort((a, b) => b.similarity - a.similarity);
  const kept = [];
  for (const match of matches) {
    const overlaps = kept.some(
      (existing) =>
        (match.start >= existing.start && match.start < existing.end) ||
        (match.end > existing.start && match.end <= existing.end)
    );
    if (!overlaps) kept.push(match);
  }
  kept.sort((a, b) => a.start - b.start);

  return { matches: kept, onlineUsed, onlineError, checked: candidates.length };
}

async function analyzePlagiarism(text, { online = true } = {}) {
  const { sentences } = documentSentences(text);
  const totalWords = words(text).length;
  const matches = scanLocal(text, sentences);

  let onlineUsed = false;
  let onlineError = null;

  if (online) {
    const scan = await scanPublicSources(text, MAX_CANDIDATES);
    onlineUsed = scan.onlineUsed;
    onlineError = scan.onlineError;
    for (const match of scan.matches) {
      if (!matches.some((m) => m.start === match.start && m.source.kind === match.source.kind)) {
        matches.push(match);
      }
    }
  }

  // De-duplicate overlapping matches, keeping the strongest.
  matches.sort((a, b) => b.similarity - a.similarity);
  const kept = [];
  for (const m of matches) {
    const overlap = kept.some(
      (k) =>
        k.source.kind === m.source.kind &&
        ((m.start >= k.start && m.start < k.end) || (m.end > k.start && m.end <= k.end))
    );
    if (!overlap) kept.push(m);
  }
  kept.sort((a, b) => a.start - b.start);

  const coveredWords = Math.min(
    totalWords,
    kept.reduce((sum, m) => sum + (m.matchedWords || words(m.matchedText || '').length), 0)
  );

  const coverage = totalWords ? coveredWords / totalWords : 0;
  const score = clamp(Math.round(coverage * 100), 0, 100);

  let label;
  if (!kept.length) label = 'No matching passages found';
  else if (score < 15) label = 'Minor similarities only';
  else if (score < 35) label = 'Some passages match external text';
  else label = 'Significant matching text found';

  const notes = [];
  if (!onlineUsed && onlineError) {
    notes.push(`${onlineError}. Results below use the offline quotation and repetition scan.`);
  } else if (onlineError) {
    notes.push(`One reference source was unavailable (${onlineError}); the other sources were still checked.`);
  } else if (!kept.length) {
    notes.push('No public-reference passages matched. This scan checks Wikipedia, OpenAlex academic abstracts and a library of well-known quotations — not the entire web.');
  } else {
    notes.push('Checked Wikipedia, OpenAlex academic abstracts and a quotation library. A full web index requires a commercial plagiarism API.');
  }
  if (kept.some((m) => m.source.kind === 'quotation')) {
    notes.push('Quoted material may be legitimate — add a citation rather than paraphrasing if you are quoting directly.');
  }

  return {
    score,
    label,
    coverage: Math.round(coverage * 100),
    onlineUsed,
    onlineError,
    matches: kept.slice(0, 8),
    notes,
    stats: {
      checked: Math.min(sentences.length, MAX_CANDIDATES),
      sources: new Set(kept.map((m) => m.source.url).filter(Boolean)).size,
      matchedWords: coveredWords,
    },
  };
}

module.exports = { analyzePlagiarism, scanPublicSources, KNOWN_QUOTES };
