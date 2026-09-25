"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAdminPolls = exports.getPollResults = exports.castVote = void 0;
const poll_1 = require("../poll");
const DEFAULT_QUESTION = "अहिलेको प्रधानमन्त्रीका रूपमा को उपयुक्त लाग्छ?";
const DEFAULT_OPTIONS = [
    { id: "kp-sharma-oli", label: "केपी शर्मा ओली" },
    { id: "prachanda", label: "पुष्पकमल दाहाल" },
    { id: "sher-bahadur-deuba", label: "शेरबहादुर देउवा" },
    { id: "rabi-lamichhane", label: "रवि लामिछाने" },
];
const records = new Map();
const summarize = (record) => {
    let total = 0;
    for (const value of Object.values(record.counts))
        total += value;
    return { counts: { ...record.counts }, total };
};
const ensureRecord = (pollId) => {
    const existing = records.get(pollId);
    if (existing)
        return existing;
    let question = "";
    let options = [];
    let context;
    if (pollId === "default") {
        question = DEFAULT_QUESTION;
        options = DEFAULT_OPTIONS;
    }
    else {
        const current = (0, poll_1.generatePoll)();
        if (current.id === pollId) {
            question = current.question;
            options = current.options;
            context = current.context;
        }
    }
    const record = {
        id: pollId,
        question: question || "मतदान",
        options,
        context,
        counts: {},
        voters: new Set(),
    };
    records.set(pollId, record);
    return record;
};
const castVote = (pollId, optionId, voterKey) => {
    const record = ensureRecord(pollId);
    if (record.options.length > 0 &&
        !record.options.some((o) => o.id === optionId)) {
        return { ok: false, error: "अवैध मतदान विकल्प।", alreadyVoted: false };
    }
    if (record.voters.has(voterKey)) {
        return { ok: true, alreadyVoted: true, data: summarize(record) };
    }
    record.voters.add(voterKey);
    record.counts[optionId] = (record.counts[optionId] ?? 0) + 1;
    return { ok: true, alreadyVoted: false, data: summarize(record) };
};
exports.castVote = castVote;
const getPollResults = (pollId) => {
    const record = records.get(pollId);
    return record ? summarize(record) : null;
};
exports.getPollResults = getPollResults;
const listAdminPolls = () => {
    const list = [];
    const current = (0, poll_1.generatePoll)();
    const currentRecord = records.get(current.id);
    const currentSummary = currentRecord
        ? summarize(currentRecord)
        : { counts: {}, total: 0 };
    list.push({
        ...current,
        counts: currentSummary.counts,
        total: currentSummary.total,
    });
    for (const record of records.values()) {
        if (record.id === current.id)
            continue;
        const summary = summarize(record);
        list.push({
            id: record.id,
            question: record.question,
            options: record.options,
            context: record.context,
            counts: summary.counts,
            total: summary.total,
        });
    }
    return list;
};
exports.listAdminPolls = listAdminPolls;
