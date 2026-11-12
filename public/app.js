'use strict';

/* ============================================================
   Writing Genie — client
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CIRCUMFERENCE = 2 * Math.PI * 58;

const SAMPLE_TEXT = `In today's fast-paced business world, it is important to note that effective leadership has become a pivotal factor in organizational success. Furthermore, modern leaders must leverage a myriad of strategies to navigate an ever-evolving landscape of challenges. Moreover, comprehensive communication and robust decision-making are crucial for fostering trust within diverse teams. Additionally, leaders should utilize data-driven insights to facilitate informed choices and ensure sustainable growth. As John F. Kennedy famously said, "Ask not what your country can do for you, ask what you can do for your country." In conclusion, leadership is not merely about authority — it is a transformative commitment that underscores the importance of service, empathy, and vision.`;

const state = {
  mode: 'upload',
  file: null,
  text: '',
  filename: '',
  structure: [],
  analysis: null,
  cleaned: null,
  busy: false,
};

const el = {
  tabUpload: $('#tabUpload'),
  tabPaste: $('#tabPaste'),
  uploadPane: $('#uploadPane'),
  pastePane: $('#pastePane'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  fileChip: $('#fileChip'),
  fileName: $('#fileName'),
  fileSize: $('#fileSize'),
  removeFile: $('#removeFile'),
  pasteText: $('#pasteText'),
  pasteCount: $('#pasteCount'),
  clearPaste: $('#clearPaste'),
  checkBtn: $('#checkBtn'),
  checkBtnLabel: $('#checkBtnLabel'),
  sampleBtn: $('#sampleBtn'),
  results: $('#results'),
  cleaned: $('#cleaned'),
  overlay: $('#overlay'),
  overlayTitle: $('#overlayTitle'),
  overlaySub: $('#overlaySub'),
  overlayBar: $('#overlayBar'),
  overlaySteps: $('#overlaySteps'),
  toast: $('#toast'),
};

let overlayTimer = null;
let overlayProgressTimer = null;
let toastTimer = null;
let numberAnimations = [];

/* ---------------- small helpers ---------------- */

function escapeHtml(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function countWords(text) {
  return (text.match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || []).length;
}

function scrollToEl(node) {
  node.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
}

function toast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3600);
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('Could not reach the local Writing Genie server. Is it still running?');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The server sent an unexpected response. Please try again.');
  }
  if (!response.ok) throw new Error(payload?.error || 'Something went wrong. Please try again.');
  return payload;
}

/* ---------------- overlay ---------------- */

let overlayManual = false;

function showOverlay({ title, sub, steps }, manual = false) {
  clearInterval(overlayTimer);
  clearInterval(overlayProgressTimer);
  overlayManual = manual;

  el.overlayTitle.textContent = title;
  el.overlaySub.textContent = sub;
  el.overlayBar.style.width = manual ? '2%' : '8%';
  el.overlaySteps.innerHTML = steps
    .map((step, index) => `<li class="${index === 0 ? 'active' : ''}">${escapeHtml(step)}</li>`)
    .join('');
  el.overlay.classList.remove('hidden');
  document.body.classList.add('locked');

  if (manual) return;

  let index = 0;
  let progress = 8;
  overlayProgressTimer = setInterval(() => {
    progress = Math.min(92, progress + Math.max(2, (92 - progress) * 0.16));
    el.overlayBar.style.width = `${progress.toFixed(1)}%`;
  }, 500);

  if (steps.length > 1) {
    overlayTimer = setInterval(() => {
      const items = [...el.overlaySteps.children];
      if (index < items.length - 1) {
        items[index].classList.remove('active');
        items[index].classList.add('done');
        index += 1;
        items[index].classList.add('active');
      }
    }, 1100);
  }
}

function updateOverlayProgress({ percent = 0, title, sub }) {
  if (title) el.overlayTitle.textContent = title;
  if (sub) el.overlaySub.textContent = sub;
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  el.overlayBar.style.width = `${value}%`;

  const items = [...el.overlaySteps.children];
  if (!items.length) return;
  const active = Math.min(items.length - 1, Math.floor((value / 100) * items.length));
  items.forEach((item, index) => {
    item.classList.toggle('done', index < active);
    item.classList.toggle('active', index === active);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hideOverlay() {
  clearInterval(overlayTimer);
  clearInterval(overlayProgressTimer);
  el.overlayBar.style.width = '100%';
  setTimeout(() => {
    el.overlay.classList.add('hidden');
    document.body.classList.remove('locked');
  }, 260);
}

async function withOverlay(config, task) {
  showOverlay(config);
  try {
    return await task();
  } finally {
    hideOverlay();
  }
}

/* ---------------- large-document jobs ---------------- */

const CHUNK_THRESHOLD = 60000;
const APP_CONFIG = {
  hosted: false,
  maxChars: 1000000,
  passChars: 60000,
  maxUploadMb: 12,
  chunkedJobs: true,
};
let configLoaded = false;

async function loadConfig() {
  if (configLoaded) return;
  try {
    const config = await requestJson('/api/config');
    Object.assign(APP_CONFIG, config);
  } catch {
    /* keep local defaults */
  }
  configLoaded = true;
}

async function ensureConfig() {
  if (!configLoaded) await loadConfig();
}
const LARGE_STEPS = [
  'Splitting the document into parts',
  'Reading each part for AI style',
  'Sampling public reference sources',
  'Merging the final report',
];

function jobOverlayTitle(progress, kind) {
  const part = progress.part || 0;
  const total = progress.total || 0;
  if (kind === 'humanize') {
    if (progress.phase === 'rewrite') return `Rewriting part ${part} of ${total}…`;
    if (progress.phase === 'recheck') return `Re-checking part ${part} of ${total}…`;
    if (progress.phase === 'sources') return 'Re-checking public sources…';
    if (progress.phase === 'merge') return 'Finalising the cleaned draft…';
  } else {
    if (progress.phase === 'analyze') return `Reading part ${part} of ${total}…`;
    if (progress.phase === 'sources') return 'Checking public sources…';
    if (progress.phase === 'merge') return 'Merging the final report…';
  }
  return 'Working through your document…';
}

async function runChunkedJob(type, payload, config, kind) {
  showOverlay(config, true);
  try {
    const started = await requestJson(`/api/jobs/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    updateOverlayProgress({
      percent: 2,
      sub: started.parts > 1 ? `Queued ${started.parts} parts to process…` : 'Queued for processing…',
    });

    let missedPolls = 0;
    for (let attempt = 0; attempt < 1400; attempt++) {
      await sleep(750);

      let job;
      try {
        job = await requestJson(`/api/jobs/${started.jobId}`);
        missedPolls = 0;
      } catch (error) {
        if (++missedPolls >= 3) throw error;
        continue;
      }

      if (job.status === 'done') {
        updateOverlayProgress({ percent: 100, sub: 'Building your final report…' });
        return job.result;
      }
      if (job.status === 'error') throw new Error(job.error || 'Processing failed.');

      const progress = job.progress || {};
      updateOverlayProgress({
        percent: progress.percent || 0,
        title: jobOverlayTitle(progress, kind),
        sub: `${progress.stage || 'Working'}…`,
      });
    }

    throw new Error('Processing took too long. Try splitting the document into smaller files.');
  } finally {
    hideOverlay();
  }
}

async function requestAnalysis(text, filename) {
  await ensureConfig();
  const passChars = APP_CONFIG.passChars || CHUNK_THRESHOLD;

  if (text.length <= passChars) {
    return withOverlay(
      {
        title: 'Reading between the lines…',
        sub: 'Scoring the style and checking public references.',
        steps: [
          'Splitting the draft into sentences',
          'Measuring AI-style signals',
          'Checking public reference sources',
          'Building your report',
        ],
      },
      () =>
        requestJson('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, filename }),
        })
    );
  }

  if (!APP_CONFIG.chunkedJobs) {
    return withOverlay(
      {
        title: 'Long document — processing it in parts…',
        sub: 'Each part is read separately, then merged into one report. This can take a little while.',
        steps: LARGE_STEPS,
      },
      () =>
        requestJson('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, filename }),
        })
    );
  }

  return runChunkedJob(
    'analyze',
    { text, filename },
    {
      title: 'Long document — splitting it into parts…',
      sub: 'Each part is read separately, then the results are merged.',
      steps: LARGE_STEPS,
    },
    'analyze'
  );
}

async function requestCleanup(data) {
  await ensureConfig();
  const passChars = APP_CONFIG.passChars || CHUNK_THRESHOLD;
  const payload = {
    text: state.text,
    structure: state.structure || [],
    matches: data.plagiarism.matches.map((match) => ({
      sentenceText: match.sentenceText,
      start: match.start,
      end: match.end,
    })),
  };

  if (state.text.length <= passChars) {
    return withOverlay(
      {
        title: 'Working a little magic…',
        sub: 'Rewriting the tells, then checking the result again.',
        steps: [
          'Swapping stock phrasing',
          'Varying sentence rhythm',
          'Paraphrasing matched passages',
          'Re-checking the cleaned draft',
        ],
      },
      () =>
        requestJson('/api/humanize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
    );
  }

  if (!APP_CONFIG.chunkedJobs) {
    return withOverlay(
      {
        title: 'Long document — cleaning it in parts…',
        sub: 'Rewriting each part, then re-checking the whole draft. This can take a little while.',
        steps: [
          'Rewriting each part',
          'Paraphrasing matched passages',
          'Re-checking the cleaned text',
          'Finalising the draft',
        ],
      },
      () =>
        requestJson('/api/humanize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
    );
  }

  return runChunkedJob(
    'humanize',
    payload,
    {
      title: 'Long document — cleaning it in parts…',
      sub: 'Rewriting each part, then re-checking the whole draft.',
      steps: [
        'Rewriting each part',
        'Paraphrasing matched passages',
        'Re-checking the cleaned text',
        'Finalising the draft',
      ],
    },
    'humanize'
  );
}

/* ---------------- tabs ---------------- */

function setMode(mode) {
  state.mode = mode;
  const upload = mode === 'upload';
  el.tabUpload.classList.toggle('is-active', upload);
  el.tabPaste.classList.toggle('is-active', !upload);
  el.tabUpload.setAttribute('aria-selected', String(upload));
  el.tabPaste.setAttribute('aria-selected', String(!upload));
  el.uploadPane.hidden = !upload;
  el.pastePane.hidden = upload;
  el.checkBtnLabel.textContent = upload ? 'Check my writing' : 'Check pasted text';
}

el.tabUpload.addEventListener('click', () => setMode('upload'));
el.tabPaste.addEventListener('click', () => {
  setMode('paste');
  el.pasteText.focus();
});

/* ---------------- file handling ---------------- */

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showFileChip(file) {
  el.fileName.textContent = file.name;
  el.fileSize.textContent = formatBytes(file.size);
  el.fileChip.classList.remove('hidden');
}

function clearFile() {
  state.file = null;
  state.text = '';
  el.fileInput.value = '';
  el.fileChip.classList.add('hidden');
}

async function handleFile(file) {
  if (!file) return;
  await ensureConfig();
  const allowed = ['.docx', '.pdf', '.txt', '.md', '.rtf'];
  const name = file.name.toLowerCase();
  if (!allowed.some((ext) => name.endsWith(ext))) {
    toast('That file type is not supported. Use .docx, .pdf, .txt or .md.');
    return;
  }
  if (file.size > APP_CONFIG.maxUploadMb * 1024 * 1024) {
    toast(`That file is larger than ${APP_CONFIG.maxUploadMb} MB.`);
    return;
  }

  state.file = file;
  state.text = '';
  state.filename = file.name;
  showFileChip(file);
  el.checkBtnLabel.textContent = 'Check my writing';

  try {
    const form = new FormData();
    form.append('file', file);
    const data = await withOverlay(
      {
        title: 'Opening your document…',
        sub: 'Pulling out the words and leaving the formatting behind.',
        steps: ['Opening the file', 'Extracting readable text', 'Tidying line breaks'],
      },
      () => requestJson('/api/extract', { method: 'POST', body: form })
    );
    state.text = data.text;
    state.filename = data.filename || file.name;
    state.structure = Array.isArray(data.structure) ? data.structure : [];
    const words = countWords(data.text);
    toast(`Got it — ${words.toLocaleString()} words ready to check.`);
  } catch (error) {
    clearFile();
    toast(error.message);
  }
}

el.dropzone.addEventListener('click', (event) => {
  if (event.target.closest('#removeFile')) return;
  el.fileInput.click();
});

el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    el.fileInput.click();
  }
});

el.fileInput.addEventListener('change', () => {
  handleFile(el.fileInput.files?.[0]);
});

['dragenter', 'dragover'].forEach((type) => {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('is-drag');
  });
});

['dragleave', 'drop'].forEach((type) => {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove('is-drag');
  });
});

el.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

el.removeFile.addEventListener('click', (event) => {
  event.stopPropagation();
  clearFile();
  toast('File removed.');
});

/* ---------------- paste ---------------- */

function updatePasteCount() {
  const count = countWords(el.pasteText.value);
  el.pasteCount.textContent = `${count.toLocaleString()} word${count === 1 ? '' : 's'}`;
}

el.pasteText.addEventListener('input', updatePasteCount);

el.clearPaste.addEventListener('click', () => {
  el.pasteText.value = '';
  updatePasteCount();
  el.pasteText.focus();
});

/* ---------------- analysis ---------------- */

function getTextToCheck() {
  if (state.mode === 'paste') return el.pasteText.value.trim();
  return state.text.trim();
}

async function analyze() {
  if (state.busy) return;
  await ensureConfig();
  const text = getTextToCheck();

  if (!text) {
    toast(state.mode === 'paste' ? 'Paste some text first.' : 'Choose a file first, or paste your text.');
    if (state.mode === 'paste') el.pasteText.focus();
    return;
  }
  if (text.replace(/\s/g, '').length < 40) {
    toast('Add a little more text — at least a couple of sentences.');
    return;
  }
  if (text.length > APP_CONFIG.maxChars) {
    toast(`This deployment accepts up to ${APP_CONFIG.maxChars.toLocaleString()} characters per document.`);
    return;
  }

  state.busy = true;
  el.checkBtn.disabled = true;
  el.sampleBtn.disabled = true;
  el.cleaned.classList.add('hidden');
  el.checkBtnLabel.textContent = 'Reading…';

  try {
    const data = await requestAnalysis(text, state.filename || 'Pasted text');

    state.analysis = data;
    state.text = data.text;
    state.cleaned = null;

    const existing = Array.isArray(state.structure) ? state.structure : [];
    const incoming = Array.isArray(data.structure) ? data.structure : [];
    const existingHasHeadings = existing.some((block) =>
      ['title', 'subtitle', 'h1', 'h2', 'h3'].includes(block?.type)
    );
    const incomingHasHeadings = incoming.some((block) =>
      ['title', 'subtitle', 'h1', 'h2', 'h3'].includes(block?.type)
    );
    const countsAlign = existing.length > 0 && existing.length === incoming.length;

    if (
      state.mode === 'paste' ||
      !existing.length ||
      !countsAlign ||
      (!existingHasHeadings && incomingHasHeadings)
    ) {
      state.structure = incoming;
    }

    renderReport(data);
    el.results.classList.remove('hidden');
    setTimeout(() => scrollToEl(el.results), 120);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    el.checkBtn.disabled = false;
    el.sampleBtn.disabled = false;
    el.checkBtnLabel.textContent =
      state.mode === 'upload' ? 'Check my writing' : 'Check pasted text';
  }
}

el.checkBtn.addEventListener('click', analyze);

el.sampleBtn.addEventListener('click', () => {
  setMode('paste');
  el.pasteText.value = SAMPLE_TEXT;
  updatePasteCount();
  analyze();
});

/* ---------------- report rendering ---------------- */

function scoreTone(score, kind) {
  if (kind === 'ai') return score < 30 ? 'good' : score < 72 ? 'warn' : 'bad';
  return score < 10 ? 'good' : score < 30 ? 'warn' : 'bad';
}

function animateNumber(node, target, duration = 950) {
  if (REDUCED_MOTION) {
    node.textContent = String(target);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = String(Math.round(target * eased));
    if (progress < 1) numberAnimations.push(requestAnimationFrame(tick));
  };
  requestAnimationFrame(tick);
}

function setGauge(gaugeEl, scoreEl, score, kind) {
  const circle = gaugeEl.querySelector('.gauge-fill');
  const tone = scoreTone(score, kind);
  gaugeEl.dataset.tone = tone;
  gaugeEl.dataset.score = String(score);
  circle.style.strokeDashoffset = String(CIRCUMFERENCE);
  animateNumber(scoreEl, score);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      circle.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - score / 100));
    });
  });
}

function renderAnnotated(text, ai, plagiarism) {
  const marks = [];

  ai.sentences.forEach((sentence, index) => {
    const start = Math.max(0, Math.min(text.length, sentence.start));
    const end = Math.max(0, Math.min(text.length, sentence.end));
    if (start >= text.length || end <= start) return;
    marks.push({ start, end, type: 'ai', index });
  });

  plagiarism.matches.forEach((match, index) => {
    const start = Math.max(0, Math.min(text.length, match.start));
    const end = Math.max(0, Math.min(text.length, match.end));
    if (start >= text.length || end <= start) return;
    marks.push({ start, end, type: 'plag', index });
  });

  const points = new Set([0, text.length]);
  for (const mark of marks) {
    points.add(mark.start);
    points.add(mark.end);
  }
  const sorted = [...points].sort((a, b) => a - b);

  let html = '';
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start) continue;
    const chunk = text.slice(start, end);
    if (!chunk) continue;

    const active = marks.filter((mark) => mark.start <= start && mark.end >= end);
    if (!active.length) {
      html += escapeHtml(chunk);
      continue;
    }

    const aiMark = active.find((mark) => mark.type === 'ai');
    const plagMark = active.find((mark) => mark.type === 'plag');
    const classes = ['mk'];

    let reason = '';
    if (aiMark) {
      const sentence = ai.sentences[aiMark.index];
      const score = sentence.score;
      classes.push(score >= 60 ? 'ai-high' : score >= 35 ? 'ai-mid' : 'ai-low');
      reason = sentence.reasons?.join(' ') || '';
    }
    if (plagMark) {
      classes.push('copied');
      const match = plagiarism.matches[plagMark.index];
      reason = `${reason ? `${reason} ` : ''}Matches “${match.source.title}” (${match.similarity}% overlap).`;
    }

    html += `<span class="${classes.join(' ')}"${aiMark ? ` data-ai="${aiMark.index}"` : ''}${
      plagMark ? ` data-plag="${plagMark.index}"` : ''
    } title="${escapeHtml(reason)}">${escapeHtml(chunk)}</span>`;
  }

  return html;
}

function renderInsight(aiIndex, plagIndex, data) {
  const insight = $('#insight');
  const pieces = [];

  if (plagIndex !== null) {
    const match = data.plagiarism.matches[plagIndex];
    if (match) {
      pieces.push({
        title: 'Matched source',
        body: `“${match.source.title}” shares ${match.similarity}% of this sentence — ${match.matchedWords} words. ${
          match.source.url ? 'Open the source and add a citation, or paraphrase the idea in your own words.' : 'This is repeated elsewhere in your document.'
        }`,
      });
    }
  }

  if (aiIndex !== null) {
    const sentence = data.ai.sentences[aiIndex];
    if (sentence) {
      pieces.push({
        title: `${sentence.score}% AI-leaning sentence`,
        body: sentence.reasons?.join(' ') || 'No individual markers stood out.',
      });
    }
  }

  if (!pieces.length) {
    insight.classList.add('hidden');
    return;
  }

  insight.innerHTML = pieces
    .map(
      (piece) =>
        `<span class="insight-mark">✦</span><div><strong>${escapeHtml(piece.title)}</strong> ${escapeHtml(
          piece.body
        )}</div>`
    )
    .join('');
  insight.classList.remove('hidden');
}

function buildStat(label, value, suffix = '') {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  if (suffix) {
    const small = document.createElement('small');
    small.textContent = ` ${suffix}`;
    dd.appendChild(small);
  }
  wrap.append(dt, dd);
  return wrap;
}

function renderMatches(data) {
  const list = $('#matchList');
  const count = $('#matchCount');
  list.innerHTML = '';

  const matches = data.plagiarism.matches;
  const sourceCount = new Set(matches.map((m) => m.source.url).filter(Boolean)).size;
  count.textContent = matches.length
    ? `${matches.length} passage${matches.length === 1 ? '' : 's'} · ${sourceCount} source${
        sourceCount === 1 ? '' : 's'
      }`
    : 'Nothing matched';

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8 12 2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><div>No overlapping passages in the public sources we can see.</div>`;
    list.appendChild(empty);
  }

  const kindLabel = {
    wikipedia: 'Wikipedia',
    academic: 'Academic paper',
    quotation: 'Quotation',
    internal: 'In this document',
  };

  matches.forEach((match) => {
    const card = document.createElement('article');
    card.className = 'match';

    const top = document.createElement('div');
    top.className = 'match-top';

    const kind = document.createElement('span');
    kind.className = `match-kind ${match.source.kind}`;
    kind.textContent = kindLabel[match.source.kind] || 'Source';

    const sim = document.createElement('span');
    sim.className = 'match-sim';
    sim.textContent = `${match.similarity}% overlap`;

    top.append(kind, sim);

    const title = document.createElement('h4');
    title.textContent = match.source.title;

    const quote = document.createElement('blockquote');
    quote.className = 'match-quote';
    quote.textContent = `“${match.matchedText.length > 180 ? `${match.matchedText.slice(0, 180)}…` : match.matchedText}”`;

    card.append(top, title, quote);

    if (match.source.url) {
      const link = document.createElement('a');
      link.href = match.source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      let host = 'Open source';
      try {
        host = new URL(match.source.url).hostname.replace(/^www\./, '');
      } catch {
        /* keep fallback */
      }
      link.textContent = `${host} ↗`;
      card.appendChild(link);
    } else {
      const src = document.createElement('span');
      src.className = 'match-src';
      src.textContent = match.source.snippet?.slice(0, 90) || 'Repeated content';
      card.appendChild(src);
    }

    list.appendChild(card);
  });

  const notes = $('#plagNotes');
  notes.innerHTML = '';
  if (data.plagiarism.notes?.length) {
    for (const note of data.plagiarism.notes) {
      const p = document.createElement('p');
      p.textContent = note;
      notes.appendChild(p);
    }
  }
}

const RENDER_PREVIEW_LIMIT = 80000;

function renderTextView(data, forceAll = false) {
  const view = $('#textView');
  const more = $('#renderMore');
  const isLarge = data.text.length > RENDER_PREVIEW_LIMIT;

  if (isLarge && !forceAll) {
    const preview = data.text.slice(0, RENDER_PREVIEW_LIMIT);
    view.innerHTML = renderAnnotated(preview, data.ai, data.plagiarism);
    const parts = data.parts || 1;
    $('#renderMoreText').textContent =
      `Large document — showing the first ${RENDER_PREVIEW_LIMIT.toLocaleString()} of ` +
      `${data.text.length.toLocaleString()} characters. Scores cover all ${parts} part${parts === 1 ? '' : 's'}.`;
    more.classList.remove('hidden');
  } else {
    view.innerHTML = renderAnnotated(data.text, data.ai, data.plagiarism);
    more.classList.add('hidden');
  }
  view.scrollTop = 0;
}

function renderReport(data) {
  const ai = data.ai;
  const plag = data.plagiarism;

  $('#docName').textContent = data.filename || 'Your document';
  const partsLabel = data.parts > 1 ? ` · ${data.parts} parts` : '';
  $('#docMeta').textContent = `${ai.stats.words.toLocaleString()} words · ${ai.stats.sentences} sentences · ~${ai.stats.readingMinutes} min read · Grade ${ai.stats.grade}${partsLabel}`;

  $('#aiVerdict').textContent = ai.verdict;
  $('#aiConfidence').textContent = `${ai.confidence} confidence`;
  $('#aiSummary').textContent = ai.summary;
  $('#aiFootnote').textContent =
    ai.confidence === 'low'
      ? 'Short sample: treat this as a rough signal, not a verdict.'
      : 'Style-only estimate. Detectors disagree — use this as a second opinion.';
  setGauge($('#aiGauge'), $('#aiScore'), ai.score, 'ai');

  const plagTone = scoreTone(plag.score, 'plag');
  $('#plagVerdict').textContent = plag.label;
  $('#plagConfidence').textContent = plag.onlineUsed
    ? `${plag.matches.length} match${plag.matches.length === 1 ? '' : 'es'}`
    : 'offline pass';
  $('#plagSummary').textContent = plag.matches.length
    ? `${plag.coverage}% of the words in this draft overlap public sources. Check the highlighted spans and cite anything you borrowed.`
    : 'No overlapping passages turned up in Wikipedia, academic abstracts, or the quotation library.';
  $('#plagFootnote').textContent =
    plag.notes?.[0] || 'Public-reference scan, not a full web index.';
  setGauge($('#plagGauge'), $('#plagScore'), plag.score, 'plag');
  $('#plagGauge').dataset.tone = plagTone;

  $('#textView').innerHTML = '';
  renderTextView(data);

  const signals = $('#aiSignals');
  signals.innerHTML = '';
  for (const signal of ai.signals) {
    const tone = signal.score < 35 ? 'good' : signal.score < 65 ? 'warn' : 'bad';
    const row = document.createElement('div');
    row.className = 'signal';
    row.dataset.tone = tone;
    row.innerHTML = `
      <div class="signal-top">
        <span class="signal-label"></span>
        <span class="signal-value"></span>
      </div>
      <div class="signal-bar"><span></span></div>
      <span class="signal-hint"></span>`;
    row.querySelector('.signal-label').textContent = signal.label;
    row.querySelector('.signal-value').textContent = `${Math.round(signal.score)}%`;
    row.querySelector('.signal-bar span').style.width = `${Math.max(2, signal.score)}%`;
    row.querySelector('.signal-hint').textContent = signal.hint;
    signals.appendChild(row);
  }

  const stats = $('#stats');
  stats.innerHTML = '';
  stats.append(
    buildStat('Words', ai.stats.words.toLocaleString()),
    buildStat('Sentences', ai.stats.sentences),
    buildStat('Avg. sentence', ai.stats.avgSentence, 'words'),
    buildStat('Rhythm variance', ai.stats.burstiness),
    buildStat('Unique words', ai.stats.uniqueWords),
    buildStat('Reading time', ai.stats.readingMinutes, 'min'),
    buildStat('Grade level', ai.stats.grade),
    buildStat('Flesch ease', ai.stats.flesch, '/ 100')
  );

  renderMatches(data);
  $('#insight').classList.add('hidden');
  $('#matchCount').textContent = plag.matches.length
    ? `${plag.matches.length} passage${plag.matches.length === 1 ? '' : 's'}`
    : 'Nothing matched';
}

/* ---------------- sentence insight clicks ---------------- */

$('#textView').addEventListener('click', (event) => {
  const target = event.target.closest('.mk');
  if (!target || !state.analysis) return;

  $$('#textView .mk.is-selected').forEach((node) => node.classList.remove('is-selected'));
  target.classList.add('is-selected');

  renderInsight(
    target.dataset.ai !== undefined ? Number(target.dataset.ai) : null,
    target.dataset.plag !== undefined ? Number(target.dataset.plag) : null,
    state.analysis
  );
});

$('#showFullTextBtn').addEventListener('click', () => {
  if (!state.analysis) return;
  const button = $('#showFullTextBtn');
  button.disabled = true;
  button.textContent = 'Rendering…';
  setTimeout(() => {
    renderTextView(state.analysis, true);
    button.disabled = false;
    button.textContent = 'Show the whole document';
    toast('Showing the whole document. The full report may take a moment to scroll.');
  }, 40);
});

/* ---------------- cleaning ---------------- */

async function cleanWriting() {
  if (!state.analysis || state.busy) return;
  const data = state.analysis;
  state.busy = true;

  const cleanBtn = $('#cleanBtn');
  cleanBtn.disabled = true;

  try {
    const result = await requestCleanup(data);

    state.cleaned = result;
    renderCleaned(data, result);
    el.cleaned.classList.remove('hidden');
    setTimeout(() => scrollToEl(el.cleaned), 180);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    cleanBtn.disabled = false;
  }
}

$('#cleanBtn').addEventListener('click', cleanWriting);

function renderCleanedPreview(result) {
  const output = $('#outputText');
  const blocks = Array.isArray(result.structure) ? result.structure : [];

  if (!blocks.length) {
    output.classList.remove('formatted');
    output.textContent = result.text;
    return;
  }

  const stripMarker = (text) =>
    text.replace(/^[•\-*–]\s+/, '').replace(/^>\s?/, '');

  output.classList.add('formatted');
  output.innerHTML = blocks
    .map((block) => {
      const text = escapeHtml(stripMarker(block.text));
      switch (block.type) {
        case 'title':
          return `<h3 class="preview-title">${text}</h3>`;
        case 'subtitle':
          return `<p class="preview-subtitle">${text}</p>`;
        case 'h1':
          return `<h4 class="preview-h1">${text}</h4>`;
        case 'h2':
          return `<h5 class="preview-h2">${text}</h5>`;
        case 'h3':
          return `<h6 class="preview-h3">${text}</h6>`;
        case 'li':
          return `<div class="preview-li">${text}</div>`;
        case 'quote':
          return `<blockquote class="preview-quote">${text}</blockquote>`;
        default:
          return `<p>${text}</p>`;
      }
    })
    .join('');
}

function renderCleaned(before, result) {
  $('#aiBefore').textContent = `${before.ai.score}%`;
  $('#aiAfter').textContent = `${result.ai.score}%`;
  $('#plagBefore').textContent = `${before.plagiarism.score}%`;
  $('#plagAfter').textContent = `${result.plagiarism.score}%`;

  $('#aiBeforeBar').style.width = `${before.ai.score}%`;
  $('#plagBeforeBar').style.width = `${before.plagiarism.score}%`;

  const aiDelta = before.ai.score - result.ai.score;
  const plagDelta = before.plagiarism.score - result.plagiarism.score;
  const quoteRemains =
    before.plagiarism.matches.some((m) => m.source.kind === 'quotation') ||
    result.plagiarism.matches.some((m) => m.source.kind === 'quotation');

  $('#aiDelta').textContent = aiDelta > 0 ? `Down ${aiDelta} points after clean-up` : 'No change from the first pass';
  if (plagDelta > 0) {
    $('#plagDelta').textContent = `Down ${plagDelta} points after clean-up`;
  } else if (plagDelta === 0) {
    $('#plagDelta').textContent = before.plagiarism.score === 0 ? 'No source overlap found' : 'Unchanged — check the remaining match';
  } else if (quoteRemains) {
    $('#plagDelta').textContent = 'Direct quotation preserved — add a citation (the score reflects it)';
  } else {
    $('#plagDelta').textContent = `Slightly higher (${Math.abs(plagDelta)} pt) — a close match remains`;
  }

  $('#aiAfter').classList.toggle('warn', aiDelta < 0);
  $('#plagAfter').classList.toggle('warn', plagDelta < 0);

  const changes = $('#changes');
  changes.innerHTML = '';
  const labels = result.changes?.length ? [...result.changes] : ['This draft was already reading cleanly — only light touch-ups were needed.'];
  if (quoteRemains) labels.push('Direct quotation preserved — cite the original source');
  for (const label of labels) {
    const li = document.createElement('li');
    li.textContent = label;
    changes.appendChild(li);
  }

  const review = $('#reviewList');
  review.innerHTML = '';
  const reviewItems = [];

  if (result.ai.score >= 45) {
    reviewItems.push('Some machine-ish rhythm remains. Read the sentences still flagged in the report above.');
  }
  if (result.plagiarism.matches.length) {
    reviewItems.push(
      `${result.plagiarism.matches.length} passage${result.plagiarism.matches.length === 1 ? '' : 's'} still overlap public sources. Add a citation or rephrase that part yourself.`
    );
  }
  if (result.plagiarism.matches.some((m) => m.source.kind === 'quotation')) {
    reviewItems.push('A direct quotation remains. Quoted words should be cited, not paraphrased.');
  }
  reviewItems.push('Give it one final read for tone and accuracy — the rewrite should not change your argument.');
  for (const item of reviewItems) {
    const li = document.createElement('li');
    li.textContent = item;
    review.appendChild(li);
  }

  renderCleanedPreview(result);
  if (Array.isArray(result.structure) && result.structure.length) {
    state.structure = result.structure;
  }

  const note = document.querySelector('.cleanup-note');
  if (note) note.dataset.cleaned = 'true';
}

/* ---------------- copy / download / reset ---------------- */

$('#copyBtn').addEventListener('click', async () => {
  if (!state.cleaned) return;
  try {
    await navigator.clipboard.writeText(state.cleaned.text);
    toast('Cleaned draft copied to your clipboard.');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = state.cleaned.text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
    toast('Cleaned draft copied.');
  }
});

$('#downloadBtn').addEventListener('click', () => {
  if (!state.cleaned) return;
  const base = (state.filename || 'draft').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '') || 'draft';
  const blob = new Blob([state.cleaned.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${base}-writing-genie.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Downloaded a clean .txt copy.');
});

async function downloadFormatted(format) {
  if (!state.cleaned) return;
  const isDocx = format === 'docx';
  const button = isDocx ? $('#downloadDocxBtn') : $('#downloadPdfBtn');
  button.disabled = true;

  try {
    const blob = await withOverlay(
      {
        title: `Preparing your ${isDocx ? 'Word document' : 'PDF'}…`,
        sub: 'Rebuilding the title, subtitle, heading levels and page layout.',
        steps: [
          'Reading the document structure',
          'Applying title and heading styles',
          'Laying out the pages',
          'Packaging the file',
        ],
      },
      async () => {
        let response;
        try {
          response = await fetch(`/api/export/${format}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: state.cleaned.text,
              filename: state.filename || 'draft',
              structure: state.structure || [],
            }),
          });
        } catch {
          throw new Error('Could not reach the local server to build that file.');
        }
        if (!response.ok) {
          let message = 'The formatted file could not be created.';
          try {
            const payload = await response.json();
            if (payload?.error) message = payload.error;
          } catch {
            /* ignore */
          }
          throw new Error(message);
        }
        return response.blob();
      }
    );

    const base =
      (state.filename || 'draft')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w\- ]+/g, '')
        .trim() || 'draft';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${base}-writing-genie.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`Downloaded your formatted .${format} file.`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

$('#downloadDocxBtn').addEventListener('click', () => downloadFormatted('docx'));
$('#downloadPdfBtn').addEventListener('click', () => downloadFormatted('pdf'));

function resetAll() {
  state.file = null;
  state.text = '';
  state.filename = '';
  state.structure = [];
  state.analysis = null;
  state.cleaned = null;

  el.fileInput.value = '';
  el.fileChip.classList.add('hidden');
  el.pasteText.value = '';
  updatePasteCount();
  el.results.classList.add('hidden');
  el.cleaned.classList.add('hidden');
  $('#insight').classList.add('hidden');
  $('#renderMore').classList.add('hidden');
  $('#textView').innerHTML = '';
  setMode('upload');
  window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  toast('Fresh page. Drop in your next draft.');
}

$('#newDocBtn').addEventListener('click', resetAll);
$('#startOverBtn').addEventListener('click', resetAll);

/* ---------------- misc ---------------- */

updatePasteCount();
loadConfig();
