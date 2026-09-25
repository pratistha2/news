"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePoll = generatePoll;
const news_1 = require("./data/news");
const personalities_1 = require("./data/personalities");
const RATING_OPTIONS = [
    { id: "excellent", label: "एकदम राम्रो" },
    { id: "good", label: "राम्रो" },
    { id: "average", label: "मध्यम" },
    { id: "poor", label: "नराम्रो" },
];
const STATE_OPTIONS = [
    { id: "improving", label: "सुधार हुँदै छ" },
    { id: "same", label: "उस्तै नै छ" },
    { id: "worsening", label: "निकै खस्किँदै छ" },
    { id: "unknown", label: "थाहा छैन" },
];
const AGREEMENT_OPTIONS = [
    { id: "fully-agree", label: "पूर्ण सहमत" },
    { id: "partly-agree", label: "आंशिक सहमत" },
    { id: "disagree", label: "सहमत छैन" },
    { id: "unknown", label: "थाहा छैन" },
];
const CREDIBILITY_OPTIONS = [
    { id: "credible", label: "पूर्ण विश्वसनीय" },
    { id: "partly", label: "आंशिक विश्वसनीय" },
    { id: "not-credible", label: "विश्वसनीय छैनन्" },
    { id: "unknown", label: "थाहा छैन" },
];
function sortedByDate() {
    return [...news_1.news].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}
function findTrending() {
    const sorted = sortedByDate();
    return sorted.find((n) => n.personalities.length > 0) ?? sorted[0];
}
function nameOf(slug) {
    const p = personalities_1.personalities.find((x) => x.slug === slug);
    return p ? p.name : null;
}
function topNameCandidates() {
    const count = {};
    news_1.news.forEach((n) => {
        n.personalities.forEach((slug) => {
            count[slug] = (count[slug] ?? 0) + 1;
        });
    });
    return Object.entries(count)
        .sort((a, b) => b[1] - a[1])
        .map(([slug]) => nameOf(slug))
        .filter((n) => Boolean(n));
}
function candidateOptions(anchorNames) {
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
function generatePoll() {
    const trending = findTrending();
    const anchorNames = trending.personalities
        .map(nameOf)
        .filter((n) => Boolean(n));
    const dayIndex = Math.floor(Date.now() / 86400000) % 3;
    let question = "";
    let options = [];
    if (dayIndex === 1) {
        question = anchorNames[0]
            ? `के तपाईं «${anchorNames[0]}» ले हाल ल्याइरहेका गतिविधिहरूसँग सहमत हुनुहुन्छ?`
            : `के «${trending.categoryName}» क्षेत्रका हालका समाचारलाई विश्वास गर्न सकिन्छ?`;
        options = anchorNames[0] ? AGREEMENT_OPTIONS : CREDIBILITY_OPTIONS;
    }
    else if (dayIndex === 2) {
        question =
            trending.category === "politics"
                ? "हालको राजनीतिक घटनाक्रममा सबैभन्दा प्रभावशाली व्यक्ति को?"
                : `हालको «${trending.categoryName}» सन्दर्भमा सबैभन्दा भरपर्दो व्यक्ति को?`;
        options = candidateOptions(anchorNames);
    }
    else {
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
