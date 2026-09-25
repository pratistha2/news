import { news, NewsItem } from "./data/news";
import { personalities } from "./data/personalities";

export interface PollOption {
  id: string;
  label: string;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  context: {
    title: string;
    categoryName: string;
    publishedAt: string;
    url: string;
  };
}

const RATING_OPTIONS: PollOption[] = [
  { id: "excellent", label: "एकदम राम्रो" },
  { id: "good", label: "राम्रो" },
  { id: "average", label: "मध्यम" },
  { id: "poor", label: "नराम्रो" },
];

const STATE_OPTIONS: PollOption[] = [
  { id: "improving", label: "सुधार हुँदै छ" },
  { id: "same", label: "उस्तै नै छ" },
  { id: "worsening", label: "निकै खस्किँदै छ" },
  { id: "unknown", label: "थाहा छैन" },
];

const AGREEMENT_OPTIONS: PollOption[] = [
  { id: "fully-agree", label: "पूर्ण सहमत" },
  { id: "partly-agree", label: "आंशिक सहमत" },
  { id: "disagree", label: "सहमत छैन" },
  { id: "unknown", label: "थाहा छैन" },
];

const CREDIBILITY_OPTIONS: PollOption[] = [
  { id: "credible", label: "पूर्ण विश्वसनीय" },
  { id: "partly", label: "आंशिक विश्वसनीय" },
  { id: "not-credible", label: "विश्वसनीय छैनन्" },
  { id: "unknown", label: "थाहा छैन" },
];

function sortedByDate(): NewsItem[] {
  return [...news].sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

function findTrending(): NewsItem {
  const sorted = sortedByDate();
  return sorted.find((n) => n.personalities.length > 0) ?? sorted[0];
}

function nameOf(slug: string): string | null {
  const p = personalities.find((x) => x.slug === slug);
  return p ? p.name : null;
}

function topNameCandidates(): string[] {
  const count: Record<string, number> = {};
  news.forEach((n) => {
    n.personalities.forEach((slug) => {
      count[slug] = (count[slug] ?? 0) + 1;
    });
  });
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .map(([slug]) => nameOf(slug))
    .filter((n): n is string => Boolean(n));
}

function candidateOptions(anchorNames: string[]): PollOption[] {
  const unique = [
    ...new Set([...anchorNames, ...topNameCandidates()]),
  ].slice(0, 4);
  if (unique.length < 2) {
    return [
      { id: "yes", label: "मै चर्चित व्यक्ति" },
      { id: "no", label: "थाहा छैन" },
    ];
  }
  return unique.map((name, i) => ({ id: `c${i}`, label: name }));
}

export function generatePoll(): Poll {
  const trending = findTrending();

  const anchorNames = trending.personalities
    .map(nameOf)
    .filter((n): n is string => Boolean(n));

  const dayIndex = Math.floor(Date.now() / 86_400_000) % 3;

  let question = "";
  let options: PollOption[] = [];

  if (dayIndex === 1) {
    question = anchorNames[0]
      ? `के तपाईं «${anchorNames[0]}» ले हाल ल्याइरहेका गतिविधिहरूसँग सहमत हुनुहुन्छ?`
      : `के «${trending.categoryName}» क्षेत्रका हालका समाचारलाई विश्वास गर्न सकिन्छ?`;
    options = anchorNames[0] ? AGREEMENT_OPTIONS : CREDIBILITY_OPTIONS;
  } else if (dayIndex === 2) {
    question =
      trending.category === "politics"
        ? "हालको राजनीतिक घटनाक्रममा सबैभन्दा प्रभावशाली व्यक्ति को?"
        : `हालको «${trending.categoryName}» सन्दर्भमा सबैभन्दा भरपर्दो व्यक्ति को?`;
    options = candidateOptions(anchorNames);
  } else {
    question = anchorNames[0]
      ? `तपाईंलाई «${anchorNames[0]}» को हालको काम कस्तो लाग्छ?`
      : `हालको «${trending.categoryName}» क्षेत्रको अवस्था कस्तो लाग्छ?`;
    options = anchorNames[0] ? RATING_OPTIONS : STATE_OPTIONS;
  }

  return {
    id: `${trending.id}-${dayIndex}`,
    question,
    options,
    context: {
      title: trending.title,
      categoryName: trending.categoryName,
      publishedAt: trending.publishedAt,
      url: `/news/${trending.id}`,
    },
  };
}