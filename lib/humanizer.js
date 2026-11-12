'use strict';

const { splitParagraphs, splitSentences, words } = require('./text-utils');

/** Deterministic PRNG so the same text cleans up the same way. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function matchCase(original, replacement) {
  if (!replacement) return replacement;
  if (original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return replacement.toUpperCase();
  }
  if (/^[A-Z]/.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const QUOTE_SPLIT = /("[^"\n]*"|“[^”\n]*”)/g;

/** Run a transform on prose but never on text inside double quotation marks. */
function transformOutsideQuotes(text, fn) {
  return text
    .split(QUOTE_SPLIT)
    .map((part, index) => (index % 2 === 1 ? part : fn(part)))
    .join('');
}

function replaceOutsideQuotes(text, re, replacement) {
  return transformOutsideQuotes(text, (part) => part.replace(re, replacement));
}

/** Key used to match flagged sentences even when they contain quotations. */
function canonicalSentence(text) {
  return text
    .replace(/"[^"]*"|“[^”]*”/g, ' q ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PHRASE_SWAPS = [
  [/\bin today's (?:[a-z-]+ ){0,2}world\b/gi, 'these days'],
  [/\bin (?:today's|this) (?:digital|modern) (?:age|era)\b/gi, 'right now'],
  [/\bin an era (?:where|of)\b/gi, 'at a time when'],
  [/\bit is (?:important|essential|crucial) to (?:note|remember|understand) that\s+/gi, ''],
  [/\bit(?:'s| is) worth noting that\s+/gi, ''],
  [/\b(?:have|has) (?:the ability|the capacity) to\b/gi, 'can'],
  [/\bin the realm of\b/gi, 'in'],
  [/\bthe realm of\b/gi, 'the world of'],
  [/\b(?:a|the) (?:rich |complex |intricate )?tapestry of\b/gi, 'a mix of'],
  [/\bever-(?:evolving|changing|growing)\b/gi, 'changing'],
  [/\b(?:delve|delves) into\b/gi, 'dig into'],
  [/\bdelved into\b/gi, 'dug into'],
  [/\bdelving into\b/gi, 'digging into'],
  [/\butilize\b/gi, 'use'],
  [/\butilizes\b/gi, 'uses'],
  [/\butilized\b/gi, 'used'],
  [/\butilizing\b/gi, 'using'],
  [/\bleverage\b/gi, 'use'],
  [/\bleverages\b/gi, 'uses'],
  [/\bleveraged\b/gi, 'used'],
  [/\bleveraging\b/gi, 'using'],
  [/\bfacilitate\b/gi, 'support'],
  [/\bfacilitates\b/gi, 'supports'],
  [/\bfacilitated\b/gi, 'supported'],
  [/\bfacilitating\b/gi, 'supporting'],
  [/\bunderscore\b/gi, 'show'],
  [/\bunderscores\b/gi, 'shows'],
  [/\bunderscored\b/gi, 'showed'],
  [/\bunderscoring\b/gi, 'showing'],
  [/\bfoster\b/gi, 'build'],
  [/\bfosters\b/gi, 'builds'],
  [/\bfostered\b/gi, 'built'],
  [/\bfostering\b/gi, 'building'],
  [/\bnavigate\b/gi, 'handle'],
  [/\bnavigates\b/gi, 'handles'],
  [/\bnavigated\b/gi, 'handled'],
  [/\bnavigating\b/gi, 'handling'],
  [/\bunleash\b/gi, 'unlock'],
  [/\bunleashes\b/gi, 'unlocks'],
  [/\bunleashed\b/gi, 'unlocked'],
  [/\bunleashing\b/gi, 'unlocking'],
  [/\bempower\b/gi, 'help'],
  [/\bempowers\b/gi, 'helps'],
  [/\bempowered\b/gi, 'helped'],
  [/\bempowering\b/gi, 'helping'],
  [/\belevate\b/gi, 'improve'],
  [/\belevates\b/gi, 'improves'],
  [/\belevated\b/gi, 'improved'],
  [/\belevating\b/gi, 'improving'],
  [/\bseamlessly\b/gi, 'smoothly'],
  [/\bseamless\b/gi, 'smooth'],
  [/\boptimize\b/gi, 'improve'],
  [/\boptimizes\b/gi, 'improves'],
  [/\boptimized\b/gi, 'improved'],
  [/\boptimizing\b/gi, 'improving'],
  [/\bdemonstrate\b/gi, 'show'],
  [/\bdemonstrates\b/gi, 'shows'],
  [/\bdemonstrated\b/gi, 'showed'],
  [/\bdemonstrating\b/gi, 'showing'],
  [/\bimplement\b/gi, 'set up'],
  [/\bimplements\b/gi, 'sets up'],
  [/\bimplemented\b/gi, 'set up'],
  [/\bimplementing\b/gi, 'setting up'],
  [/\benhance\b/gi, 'improve'],
  [/\benhances\b/gi, 'improves'],
  [/\benhanced\b/gi, 'improved'],
  [/\benhancing\b/gi, 'improving'],
  [/\bcommence\b/gi, 'start'],
  [/\bcommences\b/gi, 'starts'],
  [/\bcommenced\b/gi, 'started'],
  [/\bcommencing\b/gi, 'starting'],
  [/\bobtain\b/gi, 'get'],
  [/\bobtains\b/gi, 'gets'],
  [/\bobtained\b/gi, 'got'],
  [/\bobtaining\b/gi, 'getting'],
  [/\bpurchase\b/gi, 'buy'],
  [/\bpurchases\b/gi, 'buys'],
  [/\bpurchased\b/gi, 'bought'],
  [/\bpurchasing\b/gi, 'buying'],
  [/\brequire\b/gi, 'need'],
  [/\brequires\b/gi, 'needs'],
  [/\brequired\b/gi, 'needed'],
  [/\brequiring\b/gi, 'needing'],
  [/\bassist\b/gi, 'help'],
  [/\bassists\b/gi, 'helps'],
  [/\bassisted\b/gi, 'helped'],
  [/\bassisting\b/gi, 'helping'],
  [/\bapproximately\b/gi, 'about'],
  [/\bsufficient\b/gi, 'enough'],
  [/\bnumerous\b/gi, 'many'],
  [/\bindividuals\b/gi, 'people'],
  [/\bassistance\b/gi, 'help'],
  [/\ba plethora of\b/gi, 'a lot of'],
  [/\ba myriad of\b/gi, 'many'],
  [/\bmyriad of\b/gi, 'many'],
  [/\bmyriad\b/gi, 'many'],
  [/\bmultifaceted\b/gi, 'complex'],
  [/\bcomprehensive\b/gi, 'thorough'],
  [/\brobust\b/gi, 'strong'],
  [/\bpivotal\b/gi, 'key'],
  [/\bcrucial\b/gi, 'key'],
  [/\bparamount\b/gi, 'vital'],
  [/\bholistic\b/gi, 'complete'],
  [/\bsynerg(?:y|ies)\b/gi, 'teamwork'],
  [/\b(?:transformative|revolutionary)\b/gi, 'groundbreaking'],
  [/\bunparalleled\b/gi, 'unmatched'],
  [/\binvaluable\b/gi, 'really useful'],
  [/\bmeticulous(?:ly)?\b/gi, 'careful'],
  [/\bintricate\b/gi, 'detailed'],
  [/\bprofound\b/gi, 'deep'],
  [/\bbolster\b/gi, 'strengthen'],
  [/\bbolsters\b/gi, 'strengthens'],
  [/\bbolstered\b/gi, 'strengthened'],
  [/\bbolstering\b/gi, 'strengthening'],
  [/\bharness\b/gi, 'use'],
  [/\bharnesses\b/gi, 'uses'],
  [/\bharnessed\b/gi, 'used'],
  [/\bharnessing\b/gi, 'using'],
  [/\bcultivate\b/gi, 'grow'],
  [/\bcultivates\b/gi, 'grows'],
  [/\bcultivated\b/gi, 'grew'],
  [/\bcultivating\b/gi, 'growing'],
  [/\bplays an? (?:crucial|vital|pivotal|key|significant) role in\b/gi, 'is central to'],
  [/\bplay an? (?:crucial|vital|pivotal|key|significant) role in\b/gi, 'are central to'],
  [/\bplays? an? (?:important|significant) part in\b/gi, 'matters in'],
  [/\bserves? as (a|an)\b/gi, 'works as $1'],
  [/\bfunctions? as (a|an)\b/gi, 'works as $1'],
  [/\ba testament to\b/gi, 'a sign of'],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bwith regard to\b/gi, 'about'],
  [/\ba large number of\b/gi, 'many'],
  [/\bthe majority of\b/gi, 'most'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequently\b/gi, 'later'],
  [/\bconsequently\b/gi, 'so'],
  [/\bfurthermore\b/gi, 'also'],
  [/\bmoreover\b/gi, 'also'],
  [/\badditionally\b/gi, 'also'],
  [/\bnevertheless\b/gi, 'still'],
  [/\bnonetheless\b/gi, 'still'],
  [/\btherefore\b/gi, 'so'],
  [/\bthus\b/gi, 'so'],
  [/\bin conclusion\b/gi, 'to wrap up'],
  [/\bin addition\b/gi, 'also'],
  [/\ba wide range of\b/gi, 'many'],
  [/\bwhen it comes to\b/gi, 'with'],
  [/\bthis ensures that\b/gi, 'this means'],
  [/\bthis allows\b/gi, 'this lets'],
  [/\bit is clear that\b/gi, 'clearly,'],
  [/\bit's clear that\b/gi, 'clearly,'],
  [/\blook no further\b/gi, "you're in the right place"],
  [/\blet'?s dive in\b/gi, "let's get into it"],
  [/\bdive into\b/gi, 'get into'],
  [/\bunlock the potential of\b/gi, 'get more from'],
  [/\bcutting-edge\b/gi, 'new'],
  [/\bstate-of-the-art\b/gi, 'advanced'],
  [/\bgame-chang(?:er|ers)\b/gi, 'big deal'],
  [/\bat the forefront of\b/gi, 'leading'],
  [/\bevergreen\b/gi, 'lasting'],
];

const PARAPHRASE_WORDS = [
  // nouns
  [/\bseries\b/gi, 'set'],
  [/\bfortifications\b/gi, 'defenses'],
  [/\bborders\b/gi, 'edges'],
  [/\bstates\b/gi, 'regions'],
  [/\bcountry\b/gi, 'nation'],
  [/\bcountries\b/gi, 'nations'],
  [/\bgroups\b/gi, 'bands'],
  [/\btourists\b/gi, 'visitors'],
  [/\bsymbols\b/gi, 'emblems'],
  [/\bcenturies\b/gi, 'hundreds of years'],
  [/\binvasions\b/gi, 'incursions'],
  [/\bresearch\b/gi, 'study'],
  [/\banalysis\b/gi, 'review'],
  [/\bresults\b/gi, 'findings'],
  [/\bparticipants\b/gi, 'subjects'],
  [/\bchildren\b/gi, 'kids'],
  [/\bstudents\b/gi, 'learners'],
  [/\bteachers\b/gi, 'educators'],
  [/\bemployees\b/gi, 'workers'],
  [/\borganizations\b/gi, 'companies'],
  [/\borganisations\b/gi, 'companies'],
  [/\bcompanies\b/gi, 'firms'],
  [/\bbusinesses\b/gi, 'companies'],
  [/\bgovernment\b/gi, 'authorities'],
  [/\bpolicies\b/gi, 'rules'],
  [/\bmethods\b/gi, 'approaches'],
  [/\bbenefits\b/gi, 'advantages'],
  [/\bchallenges\b/gi, 'difficulties'],
  [/\bproblems\b/gi, 'issues'],
  [/\bsolutions\b/gi, 'fixes'],
  [/\bimpact\b/gi, 'effect'],
  [/\bgrowth\b/gi, 'expansion'],
  [/\bdevelopment\b/gi, 'progress'],
  [/\benvironment\b/gi, 'surroundings'],
  [/\btechnology\b/gi, 'tech'],
  [/\binformation\b/gi, 'data'],
  [/\bknowledge\b/gi, 'understanding'],
  [/\beducation\b/gi, 'learning'],
  [/\bhealth\b/gi, 'wellbeing'],
  [/\bcommunity\b/gi, 'neighbourhood'],
  [/\bcommunities\b/gi, 'neighbourhoods'],
  [/\bsociety\b/gi, 'the public'],
  [/\bculture\b/gi, 'tradition'],
  [/\bhistory\b/gi, 'the past'],
  [/\bfuture\b/gi, 'years ahead'],
  [/\bexample\b/gi, 'instance'],
  [/\breason\b/gi, 'cause'],
  [/\bpurpose\b/gi, 'aim'],
  [/\bgoal\b/gi, 'target'],
  [/\barea\b/gi, 'region'],
  [/\bworld\b/gi, 'globe'],
  [/\bpart\b/gi, 'portion'],
  [/\bnumber\b/gi, 'figure'],
  [/\bamount\b/gi, 'quantity'],
  [/\blevel\b/gi, 'degree'],
  [/\brate\b/gi, 'pace'],
  [/\bwork\b/gi, 'labour'],
  [/\bjob\b/gi, 'role'],
  [/\bteam\b/gi, 'group'],
  [/\bleader\b/gi, 'head'],
  [/\bleadership\b/gi, 'management'],
  [/\bcommunication\b/gi, 'dialogue'],
  [/\bdecision\b/gi, 'choice'],
  [/\btrust\b/gi, 'confidence'],
  [/\bsuccess\b/gi, 'achievement'],
  [/\bfailure\b/gi, 'setback'],
  [/\brisk\b/gi, 'danger'],
  [/\bopportunity\b/gi, 'chance'],
  [/\bchange\b/gi, 'shift'],
  [/\bincrease\b/gi, 'rise'],
  [/\bdecrease\b/gi, 'fall'],
  // verbs
  [/\bconstructed\b/gi, 'built'],
  [/\bconstruct(?:s)?\b/gi, 'builds'],
  [/\bprotect\b/gi, 'guard'],
  [/\bprotects\b/gi, 'guards'],
  [/\bprotected\b/gi, 'guarded'],
  [/\battracts\b/gi, 'draws'],
  [/\battract\b/gi, 'draw'],
  [/\bremains\b/gi, 'stays'],
  [/\bremain\b/gi, 'stay'],
  [/\bshows?\b/gi, 'reveals'],
  [/\bshowed\b/gi, 'revealed'],
  [/\bsuggests?\b/gi, 'indicates'],
  [/\bexamines?\b/gi, 'looks at'],
  [/\bcollected\b/gi, 'gathered'],
  [/\bassociated\b/gi, 'linked'],
  [/\bimproves?\b/gi, 'boosts'],
  [/\bimproved\b/gi, 'boosted'],
  [/\breduces?\b/gi, 'lowers'],
  [/\breduced\b/gi, 'lowered'],
  [/\bcreates?\b/gi, 'builds'],
  [/\bprovides?\b/gi, 'offers'],
  [/\bprovided\b/gi, 'offered'],
  [/\ballows?\b/gi, 'lets'],
  [/\bsupports?\b/gi, 'backs'],
  [/\bachieves?\b/gi, 'reaches'],
  [/\bconsiders?\b/gi, 'weighs'],
  [/\bdetermines?\b/gi, 'establishes'],
  [/\baffects?\b/gi, 'shapes'],
  [/\bincludes?\b/gi, 'covers'],
  [/\bproduces?\b/gi, 'yields'],
  [/\bdevelops?\b/gi, 'builds'],
  [/\bdescribes?\b/gi, 'outlines'],
  [/\bexplains?\b/gi, 'spells out'],
  [/\bunderstands?\b/gi, 'grasps'],
  [/\buses?\b/gi, 'applies'],
  [/\bfinds?\b/gi, 'identifies'],
  [/\bbegins?\b/gi, 'starts'],
  // adjectives & adverbs
  [/\bhistorical\b/gi, 'historic'],
  [/\bancient\b/gi, 'old'],
  [/\bnorthern\b/gi, 'northernmost'],
  [/\bsouthern\b/gi, 'southernmost'],
  [/\brecognizable\b/gi, 'familiar'],
  [/\bimportant\b/gi, 'essential'],
  [/\bmajor\b/gi, 'main'],
  [/\bvarious\b/gi, 'different'],
  [/\blarge\b/gi, 'big'],
  [/\bsmall\b/gi, 'little'],
  [/\bstrong\b/gi, 'powerful'],
  [/\bdifficult\b/gi, 'hard'],
  [/\bclear\b/gi, 'obvious'],
  [/\bcommon\b/gi, 'widespread'],
  [/\bmodern\b/gi, 'contemporary'],
  [/\btraditional\b/gi, 'conventional'],
  [/\beffective\b/gi, 'successful'],
  [/\befficient\b/gi, 'streamlined'],
  [/\bcomplex\b/gi, 'complicated'],
  [/\bdetailed\b/gi, 'thorough'],
  [/\bmain\b/gi, 'primary'],
  [/\bnew\b/gi, 'recent'],
  [/\bacross\b/gi, 'throughout'],
  [/\bevery year\b/gi, 'annually'],
  [/\bquickly\b/gi, 'rapidly'],
  [/\bvery\b/gi, 'especially'],
];

const CONTRACTIONS = [
  [/\bdo not\b/gi, "don't"],
  [/\bdoes not\b/gi, "doesn't"],
  [/\bdid not\b/gi, "didn't"],
  [/\bis not\b/gi, "isn't"],
  [/\bare not\b/gi, "aren't"],
  [/\bwas not\b/gi, "wasn't"],
  [/\bwere not\b/gi, "weren't"],
  [/\bcan not\b/gi, "can't"],
  [/\bcannot\b/gi, "can't"],
  [/\bcould not\b/gi, "couldn't"],
  [/\bshould not\b/gi, "shouldn't"],
  [/\bwould not\b/gi, "wouldn't"],
  [/\bwill not\b/gi, "won't"],
  [/\bhave not\b/gi, "haven't"],
  [/\bhas not\b/gi, "hasn't"],
  [/\bhad not\b/gi, "hadn't"],
  [/\bit is\b/gi, "it's"],
  [/\bthat is\b/gi, "that's"],
  [/\bthere is\b/gi, "there's"],
  [/\bthey are\b/gi, "they're"],
  [/\bwe are\b/gi, "we're"],
  [/\byou are\b/gi, "you're"],
  [/\bi am\b/gi, "I'm"],
  [/\bi have(?= (?:been|got|had|seen|done|made|taken|found|never|always|just|already|also|to)\b)/gi, "I've"],
  [/\bwe have(?= (?:been|got|had|seen|done|made|taken|found|never|always|just|already|also|to)\b)/gi, "we've"],
  [/\bthey have(?= (?:been|got|had|seen|done|made|taken|found|never|always|just|already|also|to)\b)/gi, "they've"],
  [/\bhe is\b/gi, "he's"],
  [/\bshe is\b/gi, "she's"],
  [/\blet us\b/gi, "let's"],
];

const AGGRESSIVE_SWAPS = [
  [/\bimportant\b/gi, 'key'],
  [/\bsignificant\b/gi, 'major'],
  [/\bsignificantly\b/gi, 'a lot'],
  [/\badditional\b/gi, 'extra'],
  [/\bcurrently\b/gi, 'now'],
  [/\bprovide(s|d)?\b/gi, 'give'],
  [/\bindicate(s|d)?\b/gi, 'show'],
  [/\bestablish(es|ed)?\b/gi, 'set up'],
  [/\bmaintain(s|ed)?\b/gi, 'keep'],
  [/\binitiate(s|d)?\b/gi, 'start'],
  [/\bterminate(s|d)?\b/gi, 'end'],
  [/\bmodify|modifies|modified\b/gi, 'change'],
  [/\bconstruct(ed|s)?\b/gi, 'build'],
  [/\bconsume(s|d)?\b/gi, 'use'],
  [/\bgenerate(s|d)?\b/gi, 'create'],
  [/\bparticipate(s|d)?\b/gi, 'take part'],
  [/\bdemonstrate(s|d)?\b/gi, 'show'],
  [/\bcharacteristic(s)?\b/gi, 'feature'],
  [/\bfundamental(ly)?\b/gi, 'basic'],
  [/\bparticularly\b/gi, 'especially'],
  [/\bsubstantial\b/gi, 'large'],
  [/\bconsiderable\b/gi, 'large'],
  [/\bnumerous\b/gi, 'many'],
  [/\bcommonly\b/gi, 'often'],
  [/\bgenerally\b/gi, 'usually'],
  [/\bprimarily\b/gi, 'mostly'],
  [/\bultimately\b/gi, 'in the end'],
  [/\bnevertheless|nonetheless\b/gi, 'still'],
  [/\bas a result\b/gi, 'so'],
  [/\bin addition\b/gi, 'also'],
];

const TRANSITION_OPENERS = [
  [/^However,\s*/i, 'But '],
  [/^Moreover,\s*/i, 'Also, '],
  [/^Furthermore,\s*/i, 'Also, '],
  [/^Additionally,\s*/i, 'Plus, '],
  [/^In addition,\s*/i, 'Plus, '],
  [/^Consequently,\s*/i, 'So '],
  [/^Therefore,\s*/i, 'So '],
  [/^Thus,\s*/i, 'So '],
  [/^Nevertheless,\s*/i, 'Still, '],
  [/^Nonetheless,\s*/i, 'Still, '],
  [/^In conclusion,\s*/i, 'To wrap up, '],
  [/^Overall,\s*/i, 'All in all, '],
  [/^Ultimately,\s*/i, 'In the end, '],
  [/^Importantly,\s*/i, 'More importantly, '],
  [/^Notably,\s*/i, 'In particular, '],
];

function upperFirst(s) {
  const i = s.search(/[a-zA-Z]/);
  if (i === -1) return s;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

function lowerFirst(s) {
  const i = s.search(/[a-zA-Z]/);
  if (i === -1) return s;
  const word = s.slice(i).match(/^[A-Za-z]+/)?.[0] || '';
  // Don't lowercase likely proper nouns.
  if (word.length > 2 && /^[A-Z][a-z]/.test(word) && !/^(The|This|That|These|Those|There|Then|They|We|You|It|He|She|A|An|In|On|At|For|But|And|So|If|When|While|After|Before|As|Most|Many|Some|Both|Each|Every)$/.test(word)) {
    return s;
  }
  return s.slice(0, i) + s[i].toLowerCase() + s.slice(i + 1);
}

function fixArticles(text) {
  // Only target adjectives our swaps can introduce, so we don't mangle
  // phrases like "a user" or "an hour".
  const consonantAdjectives =
    'changing|key|full|strong|smooth|complex|complete|vital|unmatched|careful|detailed|deep|new|advanced|big|major|extra|basic|large|many|groundbreaking|central|clear|solid|smarter';
  return text.replace(new RegExp(`\\ban (${consonantAdjectives})\\b`, 'gi'), 'a $1');
}

function tidy(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/\.\s*\./g, '.')
    .replace(/,\s*\./g, '.')
    .replace(/\s+’/g, '’')
    .trim();
}

/** Split overly long sentences at safe clause boundaries. */
function splitLongSentence(sentence) {
  const semi = sentence.indexOf('; ');
  if (semi > 35 && semi < sentence.length - 25) {
    return [upperFirst(sentence.slice(0, semi).trim()) + '.', upperFirst(sentence.slice(semi + 2).trim())];
  }
  const andIdx = sentence.indexOf(', and ');
  if (andIdx > 45 && andIdx < sentence.length - 35) {
    return [upperFirst(sentence.slice(0, andIdx).trim()) + '.', upperFirst(sentence.slice(andIdx + 6).trim())];
  }
  const butIdx = sentence.indexOf(', but ');
  if (butIdx > 45 && butIdx < sentence.length - 35) {
    return [upperFirst(sentence.slice(0, butIdx).trim()) + '.', upperFirst(sentence.slice(butIdx + 6).trim())];
  }
  return [sentence];
}

function varySentences(sentenceList, rng, counts) {
  const out = [];
  for (let i = 0; i < sentenceList.length; i++) {
    let s = sentenceList[i].trim();
    if (!s) continue;

    if (words(s).length > 30) {
      const parts = splitLongSentence(s);
      if (parts.length > 1) {
        counts.sentenceVariation++;
        for (const part of parts) out.push(part);
        continue;
      }
    }

    const next = sentenceList[i + 1]?.trim();
    if (
      next &&
      words(s).length <= 7 &&
      words(next).length <= 10 &&
      rng() < 0.55 &&
      !/[!?;:]$/.test(s) &&
      !/^["“(]/.test(next) &&
      !/^(I|I'm|I've|I'd|I'll)$/.test(words(next)[0] || '')
    ) {
      const merged = `${s.replace(/\.$/, '')}, and ${lowerFirst(next)}`;
      if (!/[A-Z]/.test(merged.split(', and ')[1]?.charAt(0) || '')) {
        counts.sentenceVariation++;
        out.push(merged.charAt(0).toUpperCase() + merged.slice(1));
        i++;
        continue;
      }
    }

    out.push(s);
  }
  return out;
}

function humanize(input, { matches = [] } = {}) {
  const rng = makeRng(1337);
  let text = input.trim().replace(/[‘’]/g, "'");
  const counts = {
    phrases: 0,
    contractions: 0,
    transitions: 0,
    emDashes: 0,
    sentenceVariation: 0,
    paraphrased: 0,
    openers: 0,
  };

  const flaggedSentences = new Set(
    matches
      .map((m) => canonicalSentence(m.sentenceText || ''))
      .filter(Boolean)
  );

  // 1. Replace AI-favoured phrasing outside quotations.
  for (const [re, replacement] of PHRASE_SWAPS) {
    text = replaceOutsideQuotes(text, re, (match) => {
      counts.phrases++;
      const raw = typeof replacement === 'function' ? replacement(match) : replacement;
      return matchCase(match, raw);
    });
  }

  // 2. Flatten em dashes and double hyphens.
  let emDashCount = 0;
  text = transformOutsideQuotes(text, (part) => {
    emDashCount += (part.match(/[—–]|\s--\s/g) || []).length;
    return part
      .replace(/\s*[—–]\s*/g, (match, offset, whole) => {
        const after = whole.slice(offset + match.length).trimStart();
        const before = whole.slice(0, offset);
        if (
          /^(it|this|that|they|we|you|he|she|there|these|those)\b/i.test(after) &&
          !/[.!?]\s*$/.test(before)
        ) {
          return '. ';
        }
        return ', ';
      })
      .replace(/\s+--\s+/g, ', ');
  });
  counts.emDashes = emDashCount;
  text = text.replace(/,\s*,/g, ',');

  // 3. Soften stiff sentence openers.
  const openerPatterns = [...TRANSITION_OPENERS];
  const processed = [];

  for (const paragraph of splitParagraphs(text)) {
    const rawSentences = splitSentences(paragraph.text).map((s) => s.text.trim());
    const cleaned = rawSentences.map((sentence) => {
      let s = sentence;
      for (const [re, replacement] of openerPatterns) {
        if (re.test(s)) {
          s = s.replace(re, replacement);
          counts.transitions++;
          break;
        }
      }
      if (/^Also,\s+/i.test(s) && rng() < 0.72) {
        const openers = ['Plus, ', 'And ', 'On top of that, '];
        s = s.replace(/^Also,\s+/i, openers[Math.floor(rng() * openers.length)]);
        counts.openers++;
      }

      const key = canonicalSentence(sentence);
      if (flaggedSentences.has(key)) {
        const before = s;
        s = transformOutsideQuotes(s, (part) => {
          let segment = part;
          for (const [re, replacement] of AGGRESSIVE_SWAPS) {
            segment = segment.replace(re, (match) => {
              const raw = typeof replacement === 'function' ? replacement(match) : replacement;
              return matchCase(match, raw);
            });
          }
          for (const [re, replacement] of PARAPHRASE_WORDS) {
            segment = segment.replace(re, (match) => matchCase(match, replacement));
          }
          return segment;
        });
        if (s !== before) counts.paraphrased++;
      }

      // Natural contractions, applied with a light touch.
      s = transformOutsideQuotes(s, (part) => {
        let segment = part;
        for (const [re, replacement] of CONTRACTIONS) {
          segment = segment.replace(re, (match) => {
            if (rng() < 0.82) {
              counts.contractions++;
              return matchCase(match, replacement);
            }
            return match;
          });
        }
        return segment;
      });

      return upperFirst(tidy(s));
    });

    const varied = varySentences(cleaned, rng, counts);
    processed.push(varied.join(' '));
  }

  text = tidy(processed.join('\n\n'));
  text = fixArticles(text);
  text = text.replace(/\n{3,}/g, '\n\n');

  const labels = [];
  if (counts.phrases) labels.push(`${counts.phrases} AI-favoured phrase${counts.phrases === 1 ? '' : 's'} swapped for plainer wording`);
  if (counts.contractions) labels.push(`${counts.contractions} contraction${counts.contractions === 1 ? '' : 's'} added for a natural voice`);
  if (counts.transitions) labels.push(`${counts.transitions} stiff transition${counts.transitions === 1 ? '' : 's'} loosened`);
  if (counts.openers) labels.push(`${counts.openers} repeated “Also” opener${counts.openers === 1 ? '' : 's'} varied`);
  if (counts.emDashes) labels.push(`${counts.emDashes} em dash${counts.emDashes === 1 ? '' : 'es'} removed`);
  if (counts.paraphrased) labels.push(`${counts.paraphrased} matched passage${counts.paraphrased === 1 ? '' : 's'} paraphrased`);
  if (counts.sentenceVariation) labels.push(`${counts.sentenceVariation} sentence-length adjustment${counts.sentenceVariation === 1 ? '' : 's'} for better rhythm`);

  return { text, changes: labels, counts };
}

module.exports = { humanize };
