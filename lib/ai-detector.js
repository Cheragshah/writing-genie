'use strict';

const {
  documentSentences,
  words,
  readability,
  stdDev,
  clamp,
} = require('./text-utils');

/**
 * Weighted catalogue of phrasing that language models reach for far more
 * often than people do in ordinary prose. Weights reflect how diagnostic a
 * phrase is, not how "bad" it is.
 */
const PHRASES = [
  { re: /\bin today's (?:[a-z-]+ ){0,2}world\b/gi, label: "in today's fast-paced world", weight: 3.2 },
  { re: /\bin (?:today's|this) (?:digital|modern) (?:age|era)\b/gi, label: 'in this digital age', weight: 2.4 },
  { re: /\bin an era (?:where|of)\b/gi, label: 'in an era where', weight: 2.2 },
  { re: /\bit is (?:important|essential|crucial) to (?:note|remember|understand) (?:that|how)\b/gi, label: 'it is important to note that', weight: 2.6 },
  { re: /\bit(?:'s| is) worth noting that\b/gi, label: "it's worth noting that", weight: 2.4 },
  { re: /\b(?:delve|delves|delved|delving) into\b/gi, label: 'delve into', weight: 2.8 },
  { re: /\bthe realm of\b/gi, label: 'the realm of', weight: 2.3 },
  { re: /\b(?:a|the) (?:rich |complex |intricate )?tapestry of\b/gi, label: 'tapestry of', weight: 2.8 },
  { re: /\bever-(?:evolving|changing|growing)\b/gi, label: 'ever-evolving', weight: 2.2 },
  { re: /\b(?:multifaceted|multi-faceted)\b/gi, label: 'multifaceted', weight: 2.2 },
  { re: /\ba plethora of\b/gi, label: 'a plethora of', weight: 2.1 },
  { re: /\bmyriad(?: of)?\b/gi, label: 'myriad', weight: 1.6 },
  { re: /\b(?:utilize|utilizes|utilized|utilizing)\b/gi, label: 'utilize', weight: 1.8 },
  { re: /\b(?:leverag|leverag)(?:e|es|ed|ing)\b/gi, label: 'leverage', weight: 2.0 },
  { re: /\b(?:facilitat)(?:e|es|ed|ing)\b/gi, label: 'facilitate', weight: 1.7 },
  { re: /\b(?:underscor)(?:e|es|ed|ing)\b/gi, label: 'underscore', weight: 2.0 },
  { re: /\b(?:foster)(?:s|ed|ing)?\b/gi, label: 'foster', weight: 1.5 },
  { re: /\b(?:navigat)(?:e|es|ed|ing)\b/gi, label: 'navigate', weight: 1.4 },
  { re: /\b(?:unleash)(?:es|ed|ing)?\b/gi, label: 'unleash', weight: 1.7 },
  { re: /\b(?:empower)(?:s|ed|ing)?\b/gi, label: 'empower', weight: 1.5 },
  { re: /\b(?:elevat)(?:e|es|ed|ing)\b/gi, label: 'elevate', weight: 1.4 },
  { re: /\b(?:seamless|seamlessly)\b/gi, label: 'seamless', weight: 2.1 },
  { re: /\b(?:robust)\b/gi, label: 'robust', weight: 1.5 },
  { re: /\b(?:holistic)\b/gi, label: 'holistic', weight: 2.0 },
  { re: /\b(?:synerg)(?:y|ies|istic)\b/gi, label: 'synergy', weight: 2.2 },
  { re: /\b(?:paradigm)\b/gi, label: 'paradigm', weight: 2.0 },
  { re: /\b(?:cutting-edge|state-of-the-art)\b/gi, label: 'cutting-edge', weight: 1.8 },
  { re: /\b(?:game-chang)(?:er|ers|ing)\b/gi, label: 'game-changer', weight: 1.8 },
  { re: /\bat the forefront of\b/gi, label: 'at the forefront of', weight: 1.8 },
  { re: /\ba testament to\b/gi, label: 'a testament to', weight: 2.2 },
  { re: /\bplays? (?:a|an) (?:crucial|vital|pivotal|significant|key) role\b/gi, label: 'plays a crucial role', weight: 2.0 },
  { re: /\b(?:serves? as|functions? as)\b/gi, label: 'serves as', weight: 1.0 },
  { re: /\b(?:it is|it's) (?:not just|more than) (?:a|an|about)\b/gi, label: "it's not just a…", weight: 1.8 },
  { re: /\bnot only\b[^.!?]{0,80}?\bbut also\b/gi, label: 'not only… but also', weight: 1.6 },
  { re: /\bin conclusion\b/gi, label: 'in conclusion', weight: 2.0 },
  { re: /\b(?:furthermore|moreover)\b/gi, label: 'furthermore / moreover', weight: 1.8 },
  { re: /\badditionally\b/gi, label: 'additionally', weight: 1.5 },
  { re: /\b(?:nevertheless|nonetheless)\b/gi, label: 'nevertheless', weight: 1.4 },
  { re: /\bconsequently\b/gi, label: 'consequently', weight: 1.3 },
  { re: /\b(?:comprehensive|comprehensively)\b/gi, label: 'comprehensive', weight: 1.5 },
  { re: /\b(?:crucial|crucially)\b/gi, label: 'crucial', weight: 1.4 },
  { re: /\bpivotal\b/gi, label: 'pivotal', weight: 1.9 },
  { re: /\b(?:optimal|optimize|optimizing)\b/gi, label: 'optimize', weight: 1.3 },
  { re: /\b(?:profound|profoundly)\b/gi, label: 'profound', weight: 1.2 },
  { re: /\b(?:intricate|intricately)\b/gi, label: 'intricate', weight: 1.5 },
  { re: /\b(?:meticulous|meticulously)\b/gi, label: 'meticulous', weight: 1.5 },
  { re: /\b(?:bolster|bolsters|bolstered|bolstering)\b/gi, label: 'bolster', weight: 1.5 },
  { re: /\b(?:harness|harnessing|harnessed)\b/gi, label: 'harness', weight: 1.3 },
  { re: /\b(?:cultivat)(?:e|es|ed|ing)\b/gi, label: 'cultivate', weight: 1.4 },
  { re: /\b(?:transformative|revolutionize|revolutionizing)\b/gi, label: 'transformative', weight: 1.7 },
  { re: /\b(?:invaluable|unparalleled)\b/gi, label: 'invaluable', weight: 1.3 },
  { re: /\b(?:paramount)\b/gi, label: 'paramount', weight: 1.8 },
  { re: /\b(?:look no further|let'?s dive in|let'?s get started)\b/gi, label: 'look no further / let’s dive in', weight: 2.4 },
  { re: /\b(?:when it comes to)\b/gi, label: 'when it comes to', weight: 0.6 },
  { re: /\b(?:a wide range of)\b/gi, label: 'a wide range of', weight: 0.7 },
  { re: /\b(?:plays? an? (?:important|significant) part)\b/gi, label: 'plays an important part', weight: 0.9 },
  { re: /\b(?:it is|it's) clear that\b/gi, label: "it's clear that", weight: 1.1 },
  { re: /\b(?:this|which) (?:ensures|allows|enables) (?:that|for)\b/gi, label: 'this ensures / allows', weight: 0.8 },
];

const TRANSITION_START = /^(however|moreover|furthermore|additionally|consequently|therefore|thus|overall|ultimately|in conclusion|in addition|firstly|secondly|thirdly|finally|notably|importantly|similarly|likewise|conversely|meanwhile|subsequently)\b[,:]?\s+/i;

const CONTRACTIONS = /\b(?:don't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|couldn't|shouldn't|wouldn't|won't|haven't|hasn't|hadn't|it's|that's|there's|they're|we're|you're|i'm|i've|we've|they've|he's|she's|let's|you'll|we'll|they'll|i'd|you'd)\b/gi;

const FORMAL_MARKERS = /\b(?:individuals|numerous|approximately|sufficient|commence|terminate|obtain|purchase|assistance|regarding|prior to|in order to|due to the fact that|with regard to)\b/gi;

function countMatches(text, re) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return (text.match(r) || []).length;
}

function analyzeAI(text) {
  const { sentences, paragraphs } = documentSentences(text);
  const wordList = words(text);
  const wordCount = wordList.length;
  const sentenceCount = Math.max(1, sentences.length);
  const paragraphCount = Math.max(1, paragraphs.length);

  const sentenceLengths = sentences.map((s) => words(s.text).length);
  const avgSentence = sentenceLengths.length
    ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length
    : 0;
  const sd = stdDev(sentenceLengths);
  const burstiness = avgSentence ? sd / avgSentence : 0;

  // --- phrase density -------------------------------------------------
  const hits = [];
  let phraseWeight = 0;
  for (const p of PHRASES) {
    const count = countMatches(text, p.re);
    if (count > 0) {
      hits.push({ label: p.label, count, weight: p.weight });
      phraseWeight += count * p.weight;
    }
  }
  hits.sort((a, b) => b.count * b.weight - a.count * a.weight);
  const phrasePer100 = wordCount ? (phraseWeight / wordCount) * 100 : 0;

  // --- rhythm ---------------------------------------------------------
  const typical = sentenceLengths.filter((n) => n >= 14 && n <= 26).length / sentenceCount;
  const rhythmSignal = clamp(
    ((0.62 - burstiness) / 0.4) * 68 + (typical - 0.45) * 70,
    0,
    100
  );

  // --- transitions ----------------------------------------------------
  const transitionOpens = sentences.filter((s) => TRANSITION_START.test(s.text)).length;
  const transitionRate = transitionOpens / sentenceCount;

  // --- contractions ---------------------------------------------------
  const contractions = countMatches(text, CONTRACTIONS);
  const contractionRate = wordCount ? (contractions / wordCount) * 100 : 0;

  // --- em dashes ------------------------------------------------------
  const emDashes = (text.match(/—|--/g) || []).length;
  const emDashRate = wordCount ? (emDashes / wordCount) * 100 : 0;

  // --- formulaic devices ---------------------------------------------
  const triads = (text.match(/\b\w+,\s+\w+,\s+and\s+\w+\b/g) || []).length;
  const notOnly = countMatches(text, /\bnot only\b[^.!?]{0,80}?\bbut also\b/gi);
  const formulaicRate = wordCount ? ((triads + notOnly * 1.5) / wordCount) * 100 : 0;

  // --- repeated openers ----------------------------------------------
  const openers = sentences.map((s) => (words(s.text)[0] || '').toLowerCase()).filter(Boolean);
  const openerCounts = openers.reduce((acc, w) => ((acc[w] = (acc[w] || 0) + 1), acc), {});
  const repeatedOpeners = Object.values(openerCounts).reduce((sum, n) => sum + (n > 1 ? n - 1 : 0), 0);
  const openerRate = sentenceCount > 1 ? repeatedOpeners / (sentenceCount - 1) : 0;

  // --- paragraph uniformity ------------------------------------------
  const paraLengths = paragraphs.map((p) => words(p.text).length);
  const paraAvg = paraLengths.reduce((a, b) => a + b, 0) / paragraphCount;
  const paraCv = paraAvg ? stdDev(paraLengths) / paraAvg : 0;
  const paragraphUniformity = paragraphCount >= 3 ? clamp(((0.55 - paraCv) / 0.45) * 100, 0, 100) : 50;

  // --- surface polish -------------------------------------------------
  const cleanStarts = sentences.filter((s) => /^[A-Z0-9"'“(]/.test(s.text)).length / sentenceCount;
  const cleanEnds = sentences.filter((s) => /[.!?]["'”’)]?$/.test(s.text)).length / sentenceCount;
  const messy = / {2,}|[a-z]\s{1,}\.|\bi\s/g.test(text) ? 0.9 : 1;
  const polish = clamp(((cleanStarts * 0.4 + cleanEnds * 0.4 + messy * 0.2) - 0.7) * 250, 0, 100);

  // --- lexical variety ------------------------------------------------
  const content = wordList
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3);
  const uniqueRatio = content.length ? new Set(content).size / content.length : 1;
  const expectedUnique = clamp(0.9 - 0.1 * Math.log10(Math.max(content.length, 10)), 0.5, 0.9);
  const lexicalSignal = clamp(50 + (expectedUnique - uniqueRatio) * 160, 0, 100);

  const signals = [
    {
      key: 'phrasing',
      label: 'AI-favoured phrasing',
      score: clamp((phrasePer100 / 6) * 100, 0, 100),
      hint: `${hits.reduce((n, h) => n + h.count, 0)} formulaic phrase${hits.reduce((n, h) => n + h.count, 0) === 1 ? '' : 's'} detected`,
      weight: 0.26,
    },
    {
      key: 'rhythm',
      label: 'Sentence rhythm',
      score: clamp(rhythmSignal, 0, 100),
      hint: `${Math.round(typical * 100)}% of sentences sit in the 14–26 word AI sweet spot`,
      weight: 0.16,
    },
    {
      key: 'transitions',
      label: 'Formal transitions',
      score: clamp((transitionRate / 0.24) * 100, 0, 100),
      hint: `${transitionOpens} sentence${transitionOpens === 1 ? '' : 's'} open with however/moreover/furthermore`,
      weight: 0.11,
    },
    {
      key: 'voice',
      label: 'Natural voice',
      score: clamp(((0.9 - contractionRate) / 0.9) * 100, 0, 100),
      hint: contractionRate < 0.2 ? 'Almost no contractions — very stiff' : `${contractionRate.toFixed(1)} contractions per 100 words`,
      weight: 0.12,
    },
    {
      key: 'punctuation',
      label: 'Punctuation habits',
      score: clamp((emDashRate / 1.1) * 100, 0, 100),
      hint: `${emDashes} em dash${emDashes === 1 ? '' : 'es'} — a favourite of chatbots`,
      weight: 0.06,
    },
    {
      key: 'formulaic',
      label: 'Formulaic patterns',
      score: clamp((formulaicRate / 2.4) * 100, 0, 100),
      hint: `${triads} rule-of-three list${triads === 1 ? '' : 's'}${notOnly ? `, ${notOnly} “not only… but also”` : ''}`,
      weight: 0.08,
    },
    {
      key: 'openers',
      label: 'Repetitive openers',
      score: clamp((openerRate / 0.3) * 100, 0, 100),
      hint: repeatedOpeners ? `${repeatedOpeners} repeated sentence opening${repeatedOpeners === 1 ? '' : 's'}` : 'Sentence openings vary well',
      weight: 0.06,
    },
    {
      key: 'structure',
      label: 'Paragraph symmetry',
      score: paragraphUniformity,
      hint: paragraphCount >= 3 ? `Paragraph lengths vary by ${(paraCv * 100).toFixed(0)}%` : 'Too few paragraphs to judge',
      weight: 0.06,
    },
    {
      key: 'polish',
      label: 'Surface polish',
      score: polish,
      hint: `${Math.round(cleanEnds * 100)}% of sentences are neatly closed`,
      weight: 0.07,
    },
    {
      key: 'lexical',
      label: 'Vocabulary range',
      score: lexicalSignal,
      hint: `${Math.round(uniqueRatio * 100)}% unique words (${wordCount} words)`,
      weight: 0.02,
    },
  ];

  // A short sample cannot support a confident verdict; pull toward the middle.
  const raw = signals.reduce((sum, s) => sum + s.score * s.weight, 0);
  const confidenceDamp = clamp(wordCount / 150, 0.45, 1);
  let score = raw * (0.82 + 0.18 * confidenceDamp);
  score = clamp(Math.round(score), 2, 98);

  let verdict;
  let verdictTone;
  if (score < 30) {
    verdict = 'Reads like a human wrote it';
    verdictTone = 'good';
  } else if (score < 50) {
    verdict = 'Mostly human, with a few AI habits';
    verdictTone = 'okay';
  } else if (score < 72) {
    verdict = 'Mixed signals — could go either way';
    verdictTone = 'warn';
  } else {
    verdict = 'Strong signs of AI-generated writing';
    verdictTone = 'bad';
  }

  const sentenceScores = sentences.map((s) => {
    const wc = words(s.text).length;
    let value = score * 0.52;
    const reasons = [];

    let localWeight = 0;
    const localLabels = [];
    for (const p of PHRASES) {
      const n = countMatches(s.text, p.re);
      if (n) {
        localWeight += n * p.weight;
        localLabels.push(p.label);
      }
    }
    if (localWeight) {
      value += Math.min(38, localWeight * 9);
      reasons.push(`AI-favoured phrase: “${localLabels[0]}”`);
    }
    if (TRANSITION_START.test(s.text)) {
      value += 11;
      reasons.push('Opens with a formal transition');
    }
    if (wc >= 14 && wc <= 27) {
      value += 5;
      if (!reasons.length) reasons.push('Very typical AI sentence length');
    } else if (wc < 6) {
      value -= 7;
    }
    if (/—|--/.test(s.text)) {
      value += 6;
      reasons.push('Uses an em dash');
    }
    if (!CONTRACTIONS.test(s.text) && wc >= 14) value += 3;
    if (/\b\w+,\s+\w+,\s+and\s+\w+\b/.test(s.text)) {
      value += 4;
      if (!reasons.length) reasons.push('Rule-of-three construction');
    }
    CONTRACTIONS.lastIndex = 0;

    value = clamp(Math.round(value), 3, 98);
    if (!reasons.length) {
      reasons.push(
        value >= 65
          ? 'Matches the document’s formulaic rhythm'
          : 'No strong individual AI markers'
      );
    }
    return { start: s.start, end: s.end, score: value, reasons: reasons.slice(0, 2) };
  });

  const reading = readability(text);
  const uniqueWords = new Set(wordList.map((w) => w.toLowerCase())).size;

  return {
    score,
    verdict,
    verdictTone,
    confidence: wordCount < 120 ? 'low' : wordCount < 350 ? 'medium' : 'high',
    summary: buildSummary(score, hits, burstiness, contractions, {
      transitions: transitionOpens,
      emDashes,
    }),
    signals,
    phrases: hits.slice(0, 12),
    sentences: sentenceScores,
    stats: {
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
    },
  };
}

function buildSummary(score, hits, burstiness, contractions, extras) {
  const parts = [];
  if (score >= 75) parts.push('The prose leans heavily on patterns typical of language models.');
  else if (score >= 50) parts.push('Some passages carry a distinctly machine-generated cadence.');
  else parts.push('The writing shows a mostly natural, human-sounding cadence.');

  if (hits.length) {
    const top = hits.slice(0, 3).map((h) => `“${h.label}”`).join(', ');
    parts.push(`Watch for stock phrasing such as ${top}.`);
  }
  if (burstiness < 0.4) {
    parts.push('Sentence lengths are unusually even; humans tend to swing between short and long.');
  }
  if (contractions < 2) {
    parts.push('There are almost no contractions, which adds formality that detectors notice.');
  }
  if (extras.emDashes > 2) {
    parts.push('Em dashes appear more often than is typical in casual writing.');
  }
  return parts.join(' ');
}

module.exports = { analyzeAI };
