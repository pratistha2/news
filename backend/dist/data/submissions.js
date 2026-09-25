"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSubmissions = exports.getSubmission = exports.rejectSubmission = exports.approveSubmission = exports.addSubmission = exports.submissionToNewsItem = void 0;
const personalities_1 = require("./personalities");
const submissions = [];
let sequence = 0;
const nextId = () => {
    sequence += 1;
    return `sb-${Date.now().toString(36)}-${sequence}`;
};
const submissionToNewsItem = (submission) => ({
    id: submission.id,
    title: submission.title,
    summary: submission.summary,
    content: submission.content,
    category: submission.category,
    categoryName: submission.categoryName,
    personalities: [],
    image: submission.image,
    publishedAt: submission.publishedAt ?? submission.submittedAt,
});
exports.submissionToNewsItem = submissionToNewsItem;
const addSubmission = (input) => {
    const category = personalities_1.categories.find((c) => c.slug === input.category);
    const submission = {
        id: nextId(),
        title: input.title.trim(),
        summary: input.summary.trim(),
        content: (input.content || input.summary).trim(),
        category: input.category,
        categoryName: category?.name ?? input.category,
        image: input.image.trim(),
        status: "pending",
        submittedAt: new Date().toISOString(),
        publishedAt: null,
        submittedBy: input.submittedBy,
    };
    submissions.unshift(submission);
    return submission;
};
exports.addSubmission = addSubmission;
const approveSubmission = (id) => {
    const submission = submissions.find((s) => s.id === id);
    if (!submission || submission.status !== "pending")
        return null;
    submission.status = "approved";
    submission.publishedAt = new Date().toISOString();
    return { submission, item: (0, exports.submissionToNewsItem)(submission) };
};
exports.approveSubmission = approveSubmission;
const rejectSubmission = (id) => {
    const submission = submissions.find((s) => s.id === id);
    if (!submission || submission.status !== "pending")
        return null;
    submission.status = "rejected";
    submission.publishedAt = null;
    return submission;
};
exports.rejectSubmission = rejectSubmission;
const getSubmission = (id) => submissions.find((s) => s.id === id);
exports.getSubmission = getSubmission;
const listSubmissions = (status) => {
    if (!status || status === "all")
        return [...submissions];
    return submissions.filter((s) => s.status === status);
};
exports.listSubmissions = listSubmissions;
