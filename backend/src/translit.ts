export interface TranslitGram {
  kind: "c" | "v";
  outs: string[];
}

const LONG = (o: Record<string, string[]>): string[] =>
  Object.keys(o).sort((a, b) => b.length - a.length);

const CMAP: Record<string, string[]> = {
  chh: ["छ"],
  ksh: ["क्ष"],
  gya: ["ज्ञ"],
  dny: ["ज्ञ"],
  jna: ["ज्ञ"],
  kh: ["ख"],
  gh: ["घ"],
  jh: ["झ"],
  ng: ["ङ"],
  ny: ["ञ"],
  sh: ["श", "ष"],
  ss: ["श"],
  ch: ["च", "छ"],
  th: ["थ", "ठ"],
  dh: ["ध", "ढ"],
  bh: ["भ"],
  ph: ["फ"],
  k: ["क"],
  g: ["ग"],
  j: ["ज", "झ"],
  t: ["त", "ट"],
  d: ["द", "ड"],
  n: ["न", "ण"],
  p: ["प"],
  b: ["ब", "व"],
  m: ["म"],
  y: ["य"],
  r: ["र"],
  l: ["ल"],
  v: ["व"],
  w: ["व"],
  s: ["स", "श", "ष"],
  h: ["ह"],
  f: ["फ"],
  z: ["ज"],
  c: ["क", "च", "स"],
  x: ["क्स", "स"],
};

const VOWELS_STANDALONE: Record<string, string> = {
  aam: "आं",
  aum: "औं",
  aa: "आ",
  ii: "ई",
  oo: "ऊ",
  ee: "ई",
  uu: "ऊ",
  ai: "ऐ",
  au: "औ",
  am: "अं",
  a: "अ",
  i: "इ",
  u: "उ",
  e: "ए",
  o: "ओ",
};

const VOWELS_MATRA: Record<string, string[]> = {
  aam: ["ां"],
  aum: ["ौं"],
  aa: ["ा"],
  ii: ["ी"],
  oo: ["ू"],
  ee: ["ी"],
  uu: ["ू"],
  ai: ["ै"],
  au: ["ौ"],
  am: ["ं"],
  a: ["", "ा"],
  i: ["ि", "ी"],
  u: ["ु", "ू"],
  e: ["े"],
  o: ["ो"],
};

const ANUSVARA_KEYS = new Set(["am", "aum", "aam"]);

const CONSONANT_KEYS = LONG(CMAP);
const VOWEL_KEYS = LONG({
  ...Object.fromEntries(Object.keys(VOWELS_STANDALONE).map((k) => [k, [""]])),
  ...Object.fromEntries(Object.keys(VOWELS_MATRA).map((k) => [k, [""]])),
});

const matchesKey = (text: string, pos: number, key: string): boolean =>
  text.slice(pos, pos + key.length) === key;

function tokenize(input: string): TranslitGram[] {
  const grams: TranslitGram[] = [];
  let pos = 0;

  while (pos < input.length) {
    const ch = input[pos];
    if (ch === " " || ch === "-" || ch === "'") {
      grams.push({ kind: "c" as const, outs: [ch] });
      pos += 1;
      continue;
    }
    if (!/[a-z]/.test(ch)) {
      grams.push({ kind: "c" as const, outs: [ch] });
      pos += 1;
      continue;
    }

    let key = "";
    for (const cand of CONSONANT_KEYS) {
      if (matchesKey(input, pos, cand)) {
        key = cand;
        break;
      }
    }
    if (key) {
      grams.push({ kind: "c" as const, outs: CMAP[key] });
      pos += key.length;
      continue;
    }

    key = "";
    for (const cand of VOWEL_KEYS) {
      if (!matchesKey(input, pos, cand)) continue;
      if (ANUSVARA_KEYS.has(cand) && cand !== "aam") {
        const rest = input.slice(pos + cand.length).replace(/[^a-z]/g, "");
        if (rest.length > 0) continue;
      }
      key = cand;
      break;
    }
    if (!key) {
      key = input[pos];
      pos += 1;
      grams.push({ kind: "c" as const, outs: [key] });
      continue;
    }

    const last = grams[grams.length - 1];
    const isMatra = last?.kind === "c";
    pos += key.length;
    if (isMatra) {
      grams.push({ kind: "v" as const, outs: VOWELS_MATRA[key] });
    } else {
      grams.push({ kind: "c" as const, outs: [VOWELS_STANDALONE[key]] });
    }
  }

  return grams;
}

function applyConsonantShaping(grams: TranslitGram[]): TranslitGram[] {
  return grams.map((g, i) => {
    if (g.kind !== "c") return g;
    const next = grams[i + 1];
    const bare = next && next.kind === "c";
    if (bare) return { kind: "c", outs: g.outs.flatMap((o) => [`${o}्`, o]) };
    return g;
  });
}

const MAX_VARIANTS = 256;

export function translitVariants(input: string, max = MAX_VARIANTS): string[] {
  if (!input) return [""];
  const raw = tokenize(input.toLowerCase());
  const grams = applyConsonantShaping(raw);

  let results = [""];
  for (const gram of grams) {
    const next: string[] = [];
    for (const prefix of results) {
      for (const out of gram.outs) {
        next.push(prefix + out);
        if (next.length >= max) break;
      }
      if (next.length >= max) break;
    }
    results = next;
    if (results.length >= max) break;
  }

  const primary = grams.map((g) => g.outs[0]).join("");
  results.push(primary);
  return Array.from(new Set(results));
}

export const DICTIONARY: Array<[string, string]> = [
  ["politics", "राजनीति"],
  ["political", "राजनीतिक"],
  ["sports", "खेलकुद"],
  ["economy", "अर्थतन्त्र"],
  ["economic", "आर्थिक"],
  ["entertainment", "मनोरञ्जन"],
  ["world", "विश्व"],
  ["international", "अन्तर्राष्ट्रिय"],
  ["health", "स्वास्थ्य"],
  ["education", "शिक्षा"],
  ["technology", "प्रविधि"],
  ["cricket", "क्रिकेट"],
  ["football", "फुटबल"],
  ["futsal", "फुटसल"],
  ["election", "निर्वाचन"],
  ["monsoon", "मनसुन"],
  ["budget", "बजेट"],
  ["corona", "कोरोना"],
  ["covid", "कोभिड"],
  ["earthquake", "भूकम्प"],
  ["mayor", "मेयर"],
  ["finance", "वित्त"],
  ["climate", "जलवायु"],
  ["movie", "चलचित्र"],
  ["cinema", "चलचित्र"],
  ["film", "चलचित्र"],
  ["police", "प्रहरी"],
  ["army", "सेना"],
  ["parliament", "संसद"],
  ["ministry", "मन्त्रालय"],
  ["minister", "मन्त्री"],
  ["government", "सरकार"],
  ["prime minister", "प्रधानमन्त्री"],
  ["prachanda", "प्रचण्ड"],
  ["balen", "बालेन"],
  ["balendra", "बालेन्द्र"],
  ["oli", "ओली"],
  ["kathmandu", "काठमाडौं"],
  ["nepal", "नेपाल"],
  ["news", "समाचार"],
  ["today", "आज"],
];

export function dictionaryExpansions(query: string): string[] {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  for (const [en, ne] of DICTIONARY) {
    if (q.includes(en)) out.add(ne);
    if (q.length >= 4 && en.includes(q)) out.add(ne);
  }
  return Array.from(out);
}