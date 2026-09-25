import { NewsItem } from "./news";
import { categories } from "./personalities";

export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface SubmissionInput {
  title: string;
  summary: string;
  content: string;
  category: string;
  image: string;
  submittedBy?: string;
}

export interface Submission {
  id: string;
  title: string;
  summary: string;
  content: string;
  category: string;
  categoryName: string;
  image: string;
  status: SubmissionStatus;
  submittedAt: string;
  publishedAt: string | null;
  submittedBy?: string;
}

const submissions: Submission[] = [];

let sequence = 0;

const nextId = (): string => {
  sequence += 1;
  return `sb-${Date.now().toString(36)}-${sequence}`;
};

export const submissionToNewsItem = (submission: Submission): NewsItem => ({
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

export const addSubmission = (input: SubmissionInput): Submission => {
  const category = categories.find((c) => c.slug === input.category);
  const submission: Submission = {
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

export const approveSubmission = (
  id: string
): { submission: Submission; item: NewsItem } | null => {
  const submission = submissions.find((s) => s.id === id);
  if (!submission || submission.status !== "pending") return null;
  submission.status = "approved";
  submission.publishedAt = new Date().toISOString();
  return { submission, item: submissionToNewsItem(submission) };
};

export const rejectSubmission = (id: string): Submission | null => {
  const submission = submissions.find((s) => s.id === id);
  if (!submission || submission.status !== "pending") return null;
  submission.status = "rejected";
  submission.publishedAt = null;
  return submission;
};

export const getSubmission = (id: string): Submission | undefined =>
  submissions.find((s) => s.id === id);

export const listSubmissions = (
  status?: SubmissionStatus | "all"
): Submission[] => {
  if (!status || status === "all") return [...submissions];
  return submissions.filter((s) => s.status === status);
};