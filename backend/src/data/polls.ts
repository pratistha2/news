import { generatePoll, Poll } from "../poll";

export interface PollResults {
  counts: Record<string, number>;
  total: number;
}

export interface AdminPoll {
  id: string;
  question: string;
  options: Poll["options"];
  context?: Poll["context"];
  total: number;
  counts: Record<string, number>;
}

export interface VoteOutcome {
  ok: boolean;
  error?: string;
  alreadyVoted: boolean;
  data?: PollResults;
}

interface PollRecord {
  id: string;
  question: string;
  options: Poll["options"];
  context?: Poll["context"];
  counts: Record<string, number>;
  voters: Set<string>;
}

const DEFAULT_QUESTION = "अहिलेको प्रधानमन्त्रीका रूपमा को उपयुक्त लाग्छ?";
const DEFAULT_OPTIONS: Poll["options"] = [
  { id: "kp-sharma-oli", label: "केपी शर्मा ओली" },
  { id: "prachanda", label: "पुष्पकमल दाहाल" },
  { id: "sher-bahadur-deuba", label: "शेरबहादुर देउवा" },
  { id: "rabi-lamichhane", label: "रवि लामिछाने" },
];

const records = new Map<string, PollRecord>();

const summarize = (record: PollRecord): PollResults => {
  let total = 0;
  for (const value of Object.values(record.counts)) total += value;
  return { counts: { ...record.counts }, total };
};

const resolveDefinition = (
  pollId: string
): Pick<PollRecord, "question" | "options" | "context"> | null => {
  if (pollId === "default") {
    return { question: DEFAULT_QUESTION, options: DEFAULT_OPTIONS };
  }
  const current = generatePoll();
  if (current.id === pollId) {
    return { question: current.question, options: current.options, context: current.context };
  }
  return null;
};

const ensureRecord = (pollId: string): PollRecord => {
  const existing = records.get(pollId);
  if (existing) return existing;

  const definition = resolveDefinition(pollId);
  if (!definition) {
    throw new UnknownPollError();
  }

  const record: PollRecord = {
    id: pollId,
    question: definition.question,
    options: definition.options,
    context: definition.context,
    counts: {},
    voters: new Set(),
  };
  records.set(pollId, record);
  return record;
};

export class UnknownPollError extends Error {
  constructor() {
    super("Unknown poll");
    this.name = "UnknownPollError";
  }
}

export const castVote = (
  pollId: string,
  optionId: string,
  voterKey: string
): VoteOutcome => {
  let record: PollRecord;
  try {
    record = ensureRecord(pollId);
  } catch (error) {
    if (error instanceof UnknownPollError) {
      return { ok: false, error: "मतदान फेला परेन।", alreadyVoted: false };
    }
    throw error;
  }

  if (!record.options.some((o) => o.id === optionId)) {
    return { ok: false, error: "अवैध मतदान विकल्प।", alreadyVoted: false };
  }
  if (record.voters.has(voterKey)) {
    return { ok: true, alreadyVoted: true, data: summarize(record) };
  }
  record.voters.add(voterKey);
  record.counts[optionId] = (record.counts[optionId] ?? 0) + 1;
  return { ok: true, alreadyVoted: false, data: summarize(record) };
};

export const getPollResults = (pollId: string): PollResults | null => {
  const record = records.get(pollId);
  return record ? summarize(record) : null;
};

export const listAdminPolls = (): AdminPoll[] => {
  const list: AdminPoll[] = [];

  const current = generatePoll();
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
    if (record.id === current.id) continue;
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