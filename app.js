'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { extractText, ExtractError } = require('./lib/file-extract');
const {
  normalizeText,
  unwrapHardLines,
  words,
  documentSentences,
  readability,
  stdDev,
  clamp,
  stripAiArtifacts,
} = require('./lib/text-utils');
const { analyzeAI } = require('./lib/ai-detector');
const { analyzePlagiarism, scanPublicSources } = require('./lib/plagiarism');
const { humanize } = require('./lib/humanizer');
const { detectStructure, resolveStructure, structureToText, titleFromStructure } = require('./lib/structure');
const { buildDocx, buildPdf } = require('./lib/export');

const app = express();
const IS_VERCEL = Boolean(process.env.VERCEL);
const BLOB_ENABLED = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const SINGLE_PASS_CHARS = 60000;
const CHUNK_CHARS = 58000;
const MAX_DOC_CHARS = 1000000;
const MAX_DIRECT_CHARS = IS_VERCEL ? MAX_DOC_CHARS : SINGLE_PASS_CHARS;
const MAX_DIRECT_UPLOAD_MB = IS_VERCEL ? 4 : 12;
const MAX_UPLOAD_MB = IS_VERCEL ? (BLOB_ENABLED ? 25 : 4) : 12;
const ONLINE_SAMPLE = IS_VERCEL ? 4 : 8;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DIRECT_UPLOAD_MB * 1024 * 1024, files: 1 },
});

app.use(express.json({ limit: IS_VERCEL ? '4mb' : '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Explicit fallbacks keep the page working even where a platform does not
// apply express.static (Vercel serves public/ from its CDN first).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get(['/styles.css', '/app.js', '/favicon.svg'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', req.path));
});

function prepareText(raw) {
  let text = normalizeText(raw);
  text = unwrapHardLines(text);
  // Normalise block boundaries so headings and paragraphs survive rewriting.
  const structure = detectStructure(text);
  const normalized = structure.length ? structureToText(structure) : text;
  return stripAiArtifacts(normalized);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function validateText(raw) {
  const text = prepareText(raw);
  if (text.replace(/\s/g, '').length < 40) {
    throw httpError('Add at least 40 characters — a couple of sentences is enough to start.', 400);
  }
  if (text.length > MAX_DIRECT_CHARS) {
    throw httpError(
      IS_VERCEL
        ? `Documents can be up to ${MAX_DIRECT_CHARS.toLocaleString('en-US')} characters on this deployment. Split this one and try again.`
        : `That document needs the long-document pipeline. It is over ${MAX_DIRECT_CHARS.toLocaleString('en-US')} characters.`,
      413
    );
  }
  return text;
}

function validateLongText(raw) {
  const text = prepareText(raw);
  if (text.replace(/\s/g, '').length < 40) {
    throw httpError('Add at least 40 characters — a couple of sentences is enough to start.', 400);
  }
  if (text.length > MAX_DOC_CHARS) {
    throw httpError(
      `Documents can be up to ${MAX_DOC_CHARS.toLocaleString('en-US')} characters${
        IS_VERCEL ? '' : ' (roughly 150,000 words)'
      }. Split this one and try again.`,
      413
    );
  }
  return text;
}

/**
 * Split on sentence boundaries so no sentence is cut in half. Each part stays
 * at or under the per-pass character budget.
 */
function hardSplit(text, start, end, maxChars) {
  const chunks = [];
  let position = start;
  while (position < end) {
    let cut = Math.min(position + maxChars, end);
    if (cut < end) {
      const space = text.lastIndexOf(' ', cut);
      if (space > position + maxChars * 0.5) cut = space;
    }
    if (cut <= position) cut = Math.min(position + maxChars, end);
    chunks.push({
      text: text.slice(position, cut),
      start: position,
      end: cut,
    });
    position = cut;
    while (position < end && /\s/.test(text[position])) position++;
  }
  return chunks;
}

function splitIntoChunks(text, maxChars = CHUNK_CHARS) {
  if (text.length <= maxChars) {
    return [{ text, start: 0, end: text.length }];
  }

  const { sentences } = documentSentences(text);
  if (!sentences.length) return hardSplit(text, 0, text.length, maxChars);

  const chunks = [];
  let currentStart = null;
  let currentEnd = 0;

  const flush = () => {
    if (currentStart !== null && currentEnd > currentStart) {
      chunks.push({
        text: text.slice(currentStart, currentEnd),
        start: currentStart,
        end: currentEnd,
      });
    }
    currentStart = null;
    currentEnd = 0;
  };

  for (const sentence of sentences) {
    const sentenceLength = sentence.end - sentence.start;

    if (sentenceLength > maxChars) {
      flush();
      chunks.push(...hardSplit(text, sentence.start, sentence.end, maxChars));
      continue;
    }

    if (currentStart === null) {
      currentStart = sentence.start;
      currentEnd = sentence.end;
      continue;
    }

    if (sentence.end - currentStart > maxChars) {
      flush();
      currentStart = sentence.start;
      currentEnd = sentence.end;
    } else {
      currentEnd = sentence.end;
    }
  }

  flush();
  return chunks.length ? chunks : hardSplit(text, 0, text.length, maxChars);
}

function computeStats(text) {
  const { sentences, paragraphs } = documentSentences(text);
  const wordCount = words(text).length;
  const lengths = sentences.map((sentence) => words(sentence.text).length);
  const avgSentence = lengths.length
    ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length
    : 0;
  const burstiness = avgSentence ? stdDev(lengths) / avgSentence : 0;
  const reading = readability(text);
  const uniqueWords = new Set(words(text).map((word) => word.toLowerCase())).size;

  return {
    words: wordCount,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avgSentence: Math.round(avgSentence * 10) / 10,
    burstiness: Math.round(burstiness * 100) / 100,
    uniqueWords,
    readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
    flesch: reading.flesch,
    grade: reading.grade,
    characters: text.length,
  };
}

function verdictFor(score) {
  if (score < 30) return { verdict: 'Reads like a human wrote it', tone: 'good' };
  if (score < 50) return { verdict: 'Mostly human, with a few AI habits', tone: 'okay' };
  if (score < 72) return { verdict: 'Mixed signals — could go either way', tone: 'warn' };
  return { verdict: 'Strong signs of AI-generated writing', tone: 'bad' };
}

function mergeAIScores(parts, fullText) {
  const stats = computeStats(fullText);
  const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, part.ai.stats.words), 0);

  let score = Math.round(
    parts.reduce((sum, part) => sum + part.ai.score * Math.max(1, part.ai.stats.words), 0) /
      totalWeight
  );
  score = clamp(score, 2, 98);
  const { verdict, tone } = verdictFor(score);

  const signalMap = new Map();
  for (const part of parts) {
    for (const signal of part.ai.signals) {
      const weight = Math.max(1, part.ai.stats.words);
      const entry = signalMap.get(signal.key) || {
        key: signal.key,
        label: signal.label,
        weight: signal.weight,
        score: 0,
        weightSum: 0,
        best: null,
      };
      entry.score += signal.score * weight;
      entry.weightSum += weight;
      if (!entry.best || signal.score > entry.best.score) entry.best = signal;
      signalMap.set(signal.key, entry);
    }
  }

  const signals = [...signalMap.values()].map((entry) => ({
    key: entry.key,
    label: entry.label,
    score: Math.round(entry.score / entry.weightSum),
    hint: entry.best?.hint || '',
    weight: entry.weight,
  }));

  const phraseMap = new Map();
  for (const part of parts) {
    for (const phrase of part.ai.phrases) {
      const entry = phraseMap.get(phrase.label) || {
        label: phrase.label,
        count: 0,
        weight: phrase.weight,
      };
      entry.count += phrase.count;
      entry.weight = Math.max(entry.weight, phrase.weight);
      phraseMap.set(phrase.label, entry);
    }
  }
  const phrases = [...phraseMap.values()]
    .sort((a, b) => b.count * b.weight - a.count * a.weight)
    .slice(0, 12);

  const sentenceScores = [];
  for (const part of parts) {
    for (const sentence of part.ai.sentences) {
      sentenceScores.push({
        start: sentence.start + part.chunk.start,
        end: sentence.end + part.chunk.start,
        score: sentence.score,
        reasons: sentence.reasons,
      });
    }
  }

  const summary = [];
  if (score >= 72) {
    summary.push(
      parts.length > 1
        ? 'Across the full draft, the prose leans heavily on patterns typical of language models.'
        : 'The prose leans heavily on patterns typical of language models.'
    );
  } else if (score >= 50) {
    summary.push('The full draft mixes natural passages with distinctly machine-sounding stretches.');
  } else {
    summary.push('Most of the draft reads like natural human writing.');
  }
  if (phrases.length) {
    summary.push(
      `Watch for stock phrasing such as ${phrases
        .slice(0, 3)
        .map((phrase) => `“${phrase.label}”`)
        .join(', ')}.`
    );
  }
  if (stats.burstiness < 0.4) {
    summary.push('Sentence lengths are unusually even across the document; humans tend to swing between short and long.');
  }

  return {
    score,
    verdict,
    verdictTone: tone,
    confidence: stats.words < 120 ? 'low' : stats.words < 350 ? 'medium' : 'high',
    summary: summary.join(' '),
    signals,
    phrases,
    sentences: sentenceScores,
    stats,
  };
}

function dedupeMatches(matches) {
  const sorted = [...matches].sort((a, b) => b.similarity - a.similarity);
  const kept = [];
  for (const match of sorted) {
    const overlaps = kept.some(
      (existing) =>
        (match.start >= existing.start && match.start < existing.end) ||
        (match.end > existing.start && match.end <= existing.end)
    );
    if (!overlaps) kept.push(match);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

function plagiarismLabel(score, hasMatches) {
  if (!hasMatches) return 'No matching passages found';
  if (score < 15) return 'Minor similarities only';
  if (score < 35) return 'Some passages match external text';
  return 'Significant matching text found';
}

function mergePlagiarism(parts, onlineScan, fullText, partCount) {
  const matches = [];

  for (const part of parts) {
    for (const match of part.plagiarism.matches) {
      matches.push({
        ...match,
        start: match.start + part.chunk.start,
        end: match.end + part.chunk.start,
      });
    }
  }

  if (onlineScan) {
    for (const match of onlineScan.matches) matches.push(match);
  }

  const kept = dedupeMatches(matches);
  const totalWords = words(fullText).length;
  const matchedWords = Math.min(
    totalWords,
    kept.reduce(
      (sum, match) => sum + (match.matchedWords || words(match.matchedText || '').length),
      0
    )
  );
  const coverage = totalWords ? matchedWords / totalWords : 0;
  const score = clamp(Math.round(coverage * 100), 0, 100);
  const onlineUsed = Boolean(onlineScan?.onlineUsed);

  const notes = [];
  if (onlineScan?.onlineError && !onlineUsed) {
    notes.push(
      `${onlineScan.onlineError}. Results below use the offline quotation and repetition scan.`
    );
  } else if (onlineScan?.onlineError) {
    notes.push(
      `One reference source was unavailable (${onlineScan.onlineError}); the other sources were still checked.`
    );
  }
  if (partCount > 1) {
    notes.push(
      `Large document analysed in ${partCount} parts. The public-reference scan sampled ${
        onlineScan?.checked || 0
      } sentences across the draft; quotation and repetition checks covered every part.`
    );
  }
  if (!kept.length) {
    notes.push(
      'No public-reference passages matched. This scan checks Wikipedia, OpenAlex academic abstracts and a library of well-known quotations — not the entire web.'
    );
  } else {
    notes.push(
      'Checked Wikipedia, OpenAlex academic abstracts and a quotation library. A full web index requires a commercial plagiarism API.'
    );
  }
  if (kept.some((match) => match.source.kind === 'quotation')) {
    notes.push(
      'Quoted material may be legitimate — add a citation rather than paraphrasing if you are quoting directly.'
    );
  }

  return {
    score,
    label: plagiarismLabel(score, kept.length > 0),
    coverage: Math.round(coverage * 100),
    onlineUsed,
    onlineError: onlineScan?.onlineError || null,
    matches: kept.slice(0, 80),
    notes,
    stats: {
      checked: onlineScan?.checked || 0,
      sources: new Set(kept.map((match) => match.source.url).filter(Boolean)).size,
      matchedWords,
      parts: partCount,
    },
  };
}

async function analyzeInParts(text, { onProgress } = {}) {
  const chunks = splitIntoChunks(text);
  const parts = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    onProgress?.({
      phase: 'analyze',
      part: index + 1,
      total: chunks.length,
      percent: Math.round((index / chunks.length) * 82),
    });

    const ai = analyzeAI(chunk.text);
    const plagiarism = await analyzePlagiarism(chunk.text, { online: false });
    parts.push({ chunk, ai, plagiarism });
  }

  onProgress?.({
    phase: 'sources',
    part: chunks.length,
    total: chunks.length,
    percent: 88,
  });

  const onlineScan = await scanPublicSources(text, ONLINE_SAMPLE);

  onProgress?.({
    phase: 'merge',
    part: chunks.length,
    total: chunks.length,
    percent: 96,
  });

  return {
    ai: mergeAIScores(parts, text),
    plagiarism: mergePlagiarism(parts, onlineScan, text, chunks.length),
    parts: chunks.length,
    structure: detectStructure(text),
  };
}

function buildChangeLabels(counts) {
  const labels = [];
  if (counts.phrases) {
    labels.push(
      `${counts.phrases} AI-favoured phrase${counts.phrases === 1 ? '' : 's'} swapped for plainer wording`
    );
  }
  if (counts.contractions) {
    labels.push(
      `${counts.contractions} contraction${counts.contractions === 1 ? '' : 's'} added for a natural voice`
    );
  }
  if (counts.transitions) {
    labels.push(
      `${counts.transitions} stiff transition${counts.transitions === 1 ? '' : 's'} loosened`
    );
  }
  if (counts.openers) {
    labels.push(
      `${counts.openers} repeated “Also” opener${counts.openers === 1 ? '' : 's'} varied`
    );
  }
  if (counts.emDashes) {
    labels.push(
      `${counts.emDashes} em dash${counts.emDashes === 1 ? '' : 'es'} removed`
    );
  }
  if (counts.paraphrased) {
    labels.push(
      `${counts.paraphrased} matched passage${counts.paraphrased === 1 ? '' : 's'} paraphrased`
    );
  }
  if (counts.sentenceVariation) {
    labels.push(
      `${counts.sentenceVariation} sentence-length adjustment${
        counts.sentenceVariation === 1 ? '' : 's'
      } for better rhythm`
    );
  }
  return labels;
}

/* ---------------- job queue ---------------- */

const jobs = new Map();

function createJob(type, payload) {
  const id = crypto.randomUUID();
  const chunks =
    type === 'humanize' ? splitIntoChunks(payload.text) : splitIntoChunks(payload.text);
  const job = {
    id,
    type,
    payload,
    chunks,
    status: 'queued',
    progress: {
      percent: 0,
      phase: 'starting',
      stage: 'Preparing your document',
      part: 0,
      total: chunks.length,
    },
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  setImmediate(() => runJob(job));
  return { jobId: id, parts: chunks.length, characters: payload.text.length };
}

function updateProgress(job, progress) {
  const total = progress.total || job.chunks.length;
  const part = progress.part || 0;
  const phaseLabel = {
    analyze: 'Reading style',
    sources: 'Checking public sources',
    merge: 'Merging the results',
    rewrite: 'Rewriting',
    recheck: 'Re-checking the cleaned text',
    starting: 'Preparing',
  }[progress.phase] || 'Working';

  job.progress = {
    percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
    phase: progress.phase || job.progress.phase,
    stage: part && total ? `${phaseLabel} · part ${part} of ${total}` : phaseLabel,
    part,
    total,
  };
}

async function runAnalyzeJob(job) {
  const text = job.payload.text;
  const result = await analyzeInParts(text, {
    onProgress: (progress) => {
      updateProgress(job, {
        ...progress,
        percent: 4 + (progress.percent / 100) * 92,
      });
    },
  });

  job.result = {
    text,
    filename: job.payload.filename,
    ai: result.ai,
    plagiarism: result.plagiarism,
    structure: result.structure,
    chunked: job.chunks.length > 1,
    parts: job.chunks.length,
    ms: Date.now() - job.createdAt,
  };
}

async function humanizeInParts(sourceText, flagged = [], structure = [], { chunks: providedChunks, onProgress } = {}) {
  const chunks = providedChunks || splitIntoChunks(sourceText);
  const cleanedParts = [];
  const totals = {
    phrases: 0,
    contractions: 0,
    transitions: 0,
    emDashes: 0,
    sentenceVariation: 0,
    paraphrased: 0,
    openers: 0,
  };

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    onProgress?.({
      phase: 'rewrite',
      part: index + 1,
      total: chunks.length,
      percent: 4 + (index / chunks.length) * 42,
    });

    const chunkMatches = flagged
      .filter((match) => match.end > chunk.start && match.start < chunk.end)
      .map((match) => ({
        sentenceText: match.sentenceText,
        start: match.start,
        end: match.end,
      }));

    const cleaned = humanize(chunk.text, { matches: chunkMatches });
    cleanedParts.push(cleaned.text);
    for (const key of Object.keys(totals)) {
      totals[key] += cleaned.counts[key] || 0;
    }
  }

  let cleanedText = cleanedParts[0] || '';
  for (let index = 1; index < cleanedParts.length; index++) {
    const gap = sourceText.slice(chunks[index - 1].end, chunks[index].start);
    const separator = /\n\s*\n/.test(gap) ? '\n\n' : ' ';
    cleanedText += separator + cleanedParts[index];
  }
  cleanedText = cleanedText.trim();

  const recheck = await analyzeInParts(cleanedText, {
    onProgress: (progress) => {
      onProgress?.({
        ...progress,
        phase: 'recheck',
        percent: 50 + (progress.percent / 100) * 48,
      });
    },
  });

  return {
    text: cleanedText,
    changes: buildChangeLabels(totals),
    counts: totals,
    ai: recheck.ai,
    plagiarism: recheck.plagiarism,
    structure: resolveStructure(cleanedText, structure),
    chunked: chunks.length > 1,
    parts: chunks.length,
  };
}

async function runHumanizeJob(job) {
  const result = await humanizeInParts(
    job.payload.text,
    job.payload.matches || [],
    job.payload.structure,
    {
      chunks: job.chunks,
      onProgress: (progress) => updateProgress(job, progress),
    }
  );

  job.result = {
    ...result,
    ms: Date.now() - job.createdAt,
  };
}

async function runJob(job) {
  try {
    job.status = 'running';
    updateProgress(job, { percent: 2, phase: 'starting', part: 0, total: job.chunks.length });
    if (job.type === 'analyze') await runAnalyzeJob(job);
    else await runHumanizeJob(job);
    job.status = 'done';
    updateProgress(job, {
      percent: 100,
      phase: 'done',
      part: job.chunks.length,
      total: job.chunks.length,
    });
    job.progress.stage = 'Finished';
    job.progress.part = job.chunks.length;
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);
    job.status = 'error';
    job.error = error.message || 'The large-document job failed.';
  }
}

if (!IS_VERCEL) {
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of jobs.entries()) {
      if (job.createdAt < cutoff) jobs.delete(id);
    }
  }, 10 * 60 * 1000).unref();
}

/* ---------------- routes ---------------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'Writing Genie', version: '1.3.0' });
});

app.get('/api/config', (req, res) => {
  res.json({
    hosted: IS_VERCEL,
    maxChars: MAX_DOC_CHARS,
    syncMaxChars: MAX_DIRECT_CHARS,
    passChars: SINGLE_PASS_CHARS,
    maxUploadMb: MAX_UPLOAD_MB,
    maxDirectUploadMb: MAX_DIRECT_UPLOAD_MB,
    blobUploads: BLOB_ENABLED,
    chunkedJobs: !IS_VERCEL,
    version: '1.3.0',
  });
});

app.post('/api/extract', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `That file is larger than ${MAX_DIRECT_UPLOAD_MB} MB.`
          : 'Upload failed. Try a smaller .docx, .pdf, or .txt file.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    try {
      const result = await extractText(req.file);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
});

app.post('/api/blob/upload', async (req, res, next) => {
  try {
    if (!BLOB_ENABLED) {
      throw httpError('Large uploads are not configured on this deployment.', 503);
    }
    const { handleUpload } = require('@vercel/blob/client');
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain',
          'text/markdown',
          'application/rtf',
          'application/octet-stream',
        ],
        maximumSizeInBytes: 30 * 1024 * 1024,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {},
    });
    res.json(result);
  } catch (error) {
    next(error.status ? error : httpError(error.message || 'Large upload failed.', 400));
  }
});

app.post('/api/extract-blob', async (req, res, next) => {
  const { url, pathname, contentType } = req.body || {};
  let token = null;
  let del = null;

  try {
    if (!BLOB_ENABLED) {
      throw httpError('Large uploads are not configured on this deployment.', 503);
    }
    if (typeof url !== 'string' || !url) {
      throw httpError('The uploaded file URL is missing.', 400);
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw httpError('The uploaded file URL is invalid.', 400);
    }
    if (!/(^|\.)blob\.vercel-storage\.com$/i.test(parsed.hostname)) {
      throw httpError('That upload URL is not allowed.', 400);
    }

    const blobSdk = require('@vercel/blob');
    token = process.env.BLOB_READ_WRITE_TOKEN;
    del = blobSdk.del;

    const blob = await blobSdk.get(url, { access: 'private', token });
    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      throw httpError('That uploaded file could not be found. Try uploading it again.', 404);
    }

    const buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());
    const result = await extractText({
      buffer,
      originalname: typeof pathname === 'string' ? pathname : 'upload',
      mimetype: typeof contentType === 'string' ? contentType : '',
    });
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    if (token && typeof url === 'string' && del) {
      del(url, { token }).catch(() => {});
    }
  }
});

app.post('/api/analyze', async (req, res, next) => {
  const started = Date.now();
  try {
    const text = validateText(req.body?.text || '');
    const filename =
      typeof req.body?.filename === 'string' ? req.body.filename.slice(0, 120) : 'Your document';

    if (text.length > SINGLE_PASS_CHARS) {
      const result = await analyzeInParts(text);
      res.json({
        text,
        filename,
        ai: result.ai,
        plagiarism: result.plagiarism,
        structure: result.structure,
        chunked: true,
        parts: result.parts,
        ms: Date.now() - started,
      });
      return;
    }

    const [ai, plagiarism] = await Promise.all([
      analyzeAI(text),
      analyzePlagiarism(text, { online: req.body?.online !== false }),
    ]);
    res.json({
      text,
      filename,
      ai,
      plagiarism,
      structure: detectStructure(text),
      chunked: false,
      parts: 1,
      ms: Date.now() - started,
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/jobs/analyze', (req, res, next) => {
  try {
    if (IS_VERCEL) {
      throw httpError(
        'Background jobs are not available on the hosted deployment. Use the direct analyze endpoint.',
        400
      );
    }
    const text = validateLongText(req.body?.text || '');
    const filename =
      typeof req.body?.filename === 'string' ? req.body.filename.slice(0, 120) : 'Your document';
    const job = createJob('analyze', { text, filename });
    res.status(202).json(job);
  } catch (e) {
    next(e);
  }
});

app.post('/api/jobs/humanize', (req, res, next) => {
  try {
    if (IS_VERCEL) {
      throw httpError(
        'Background jobs are not available on the hosted deployment. Use the direct clean-up endpoint.',
        400
      );
    }
    const text = validateLongText(req.body?.text || '');
    const matches = Array.isArray(req.body?.matches) ? req.body.matches.slice(0, 200) : [];
    const structure = Array.isArray(req.body?.structure) ? req.body.structure.slice(0, 4000) : [];
    const job = createJob('humanize', { text, matches, structure });
    res.status(202).json(job);
  } catch (e) {
    next(e);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  if (IS_VERCEL) {
    return res.status(404).json({ error: 'Background jobs are not available on this deployment.' });
  }
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'That job has expired. Please start again.' });

  const payload = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
  };
  if (job.status === 'done') payload.result = job.result;
  res.json(payload);
});

app.post('/api/humanize', async (req, res, next) => {
  const started = Date.now();
  try {
    const text = validateText(req.body?.text || '');
    const matches = Array.isArray(req.body?.matches) ? req.body.matches.slice(0, 200) : [];
    const structure = Array.isArray(req.body?.structure) ? req.body.structure : [];

    if (text.length > SINGLE_PASS_CHARS) {
      const result = await humanizeInParts(text, matches, structure);
      if (words(result.text).length < 20) {
        throw httpError('The rewrite came out too short. Try a longer passage.', 422);
      }
      res.json({ ...result, ms: Date.now() - started });
      return;
    }

    const cleaned = humanize(text, { matches });

    if (words(cleaned.text).length < 20) {
      throw httpError('The rewrite came out too short. Try a longer passage.', 422);
    }

    const [ai, plagiarism] = await Promise.all([
      analyzeAI(cleaned.text),
      analyzePlagiarism(cleaned.text, { online: true }),
    ]);

    res.json({
      text: cleaned.text,
      changes: cleaned.changes,
      counts: cleaned.counts,
      ai,
      plagiarism,
      structure: resolveStructure(cleaned.text, structure),
      chunked: false,
      parts: 1,
      ms: Date.now() - started,
    });
  } catch (e) {
    next(e);
  }
});

/* ---------------- formatted downloads ---------------- */

function safeBaseName(filename) {
  const withoutExtension = String(filename || 'document').replace(/\.[^.]+$/, '');
  const cleaned = withoutExtension
    .replace(/[^\w\s-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'document';
}

function prepareExport(req) {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw httpError('There is no cleaned text to export yet.', 400);
  if (text.length > 1200000) {
    throw httpError('That document is too large to export in one file.', 413);
  }

  const structure = Array.isArray(req.body?.structure) ? req.body.structure : [];
  const blocks = resolveStructure(text, structure);
  const base = safeBaseName(req.body?.filename || titleFromStructure(blocks, 'document'));
  const title = titleFromStructure(blocks, base);
  return { blocks, base, title };
}

function sendDownload(res, buffer, base, extension, contentType) {
  const ascii = base.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'document';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}-writing-genie.${extension}"; ` +
      `filename*=UTF-8''${encodeURIComponent(`${base}-writing-genie.${extension}`)}`
  );
  res.send(buffer);
}

app.post('/api/export/docx', async (req, res, next) => {
  try {
    const { blocks, base, title } = prepareExport(req);
    const buffer = await buildDocx(blocks, { title });
    sendDownload(
      res,
      buffer,
      base,
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/export/pdf', async (req, res, next) => {
  try {
    const { blocks, base, title } = prepareExport(req);
    const buffer = await buildPdf(blocks, { title });
    sendDownload(res, buffer, base, 'pdf', 'application/pdf');
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof ExtractError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `That request was too large. Documents can be up to ${MAX_DOC_CHARS.toLocaleString('en-US')} characters.`,
    });
  }
  console.error(err);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Something went wrong on our side. Please try again.',
  });
});

module.exports = app;
