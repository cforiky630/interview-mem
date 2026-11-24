import type { ContentValidationView } from "./content-validation";

export type StoredCard = {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string;
  engine: "FSRS-7";
  raw: Record<string, unknown>;
  [key: string]: unknown;
};
export type DeckGroupView = {
  id: string;
  deckId: string;
  title: string;
  category: string;
  description: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};
export type QuestionView = {
  id: string;
  sourceQuestionId?: string;
  deckId: string | null;
  groupId: string | null;
  position: number;
  parentId: string | null;
  title: string;
  answer: string;
  tags: string[];
  revision: number;
  majorRevision: number;
  needsEditing: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  isOwner: boolean;
  deckTitle: string;
  note: string;
  noteVersion: number;
  favorite: boolean;
  fsrs: StoredCard | null;
  studyVersion: number;
  reviewedRevision: number;
  validation?: ContentValidationView | null;
};
export type PublishStatus = "unpublished" | "changes" | "synced";
export type PendingDeckUpdate = {
  fromVersion: number;
  toVersion: number;
  added: number;
  updated: number;
  removed: number;
  groupsChanged: boolean;
  titleChanged: boolean;
  summary: string;
  publishedAt: string;
};
export type UnpublishedDeckDiff = {
  added: number;
  updated: number;
  removed: number;
  metaChanged: boolean;
  groupsChanged: boolean;
};
export type FollowedAuthorView = {
  authorId: string;
  authorName: string;
  autoSubscribeNew: boolean;
  createdAt: string;
  publicDeckCount: number;
  subscribedDeckCount: number;
  unsubscribedDeckCount: number;
};
export type DeckView = {
  id: string;
  title: string;
  description: string;
  groupName: string;
  groups: DeckGroupView[];
  color: string;
  visibility: string;
  isOwner: boolean;
  ownerId?: string;
  ownerName: string;
  publishedVersion: number;
  seenVersion: number;
  syncedVersion?: number;
  dismissedVersion?: number;
  pendingUpdate?: PendingDeckUpdate | null;
  publishStatus?: PublishStatus;
  unpublishedDiff?: UnpublishedDeckDiff | null;
  count: number;
  due: number;
  newCount: number;
  updatedAt: string;
  releaseSummary: string;
  sourceDeleted: boolean;
};
export type CatalogDeck = {
  id: string;
  title: string;
  description: string;
  color: string;
  ownerId: string;
  ownerName: string;
  publishedVersion: number;
  releaseSummary: string;
  publishedAt: string;
  count: number;
  groupCount: number;
  subscriberCount: number;
  tags: string[];
  subscribed: boolean;
  syncedVersion: number | null;
  hasUpdate: boolean;
  authorFollowed: boolean;
  isOwner: boolean;
  updatedAt: string;
};
export type CatalogAuthorView = {
  id: string;
  name: string;
  deckCount: number;
  questionCount: number;
  followerCount: number;
  subscriberCount: number;
  followed: boolean;
  autoSubscribeNew: boolean;
  subscribedDeckCount: number;
  unsubscribedDeckCount: number;
  latestPublishedAt: string;
  isSelf: boolean;
  decks: {
    id: string;
    title: string;
    count: number;
    color: string;
    subscribed: boolean;
  }[];
};
export type RichCatalogResponse = {
  decks: CatalogDeck[];
  authors: CatalogAuthorView[];
  sharedDeck?: CatalogDeck | null;
  focusedAuthor?: CatalogAuthorView | null;
};
export type CatalogDeckPreview = {
  deck: CatalogDeck;
  groups: {
    id: string;
    category: string;
    title: string;
    description: string;
    position: number;
    count: number;
  }[];
  sampleQuestions: {
    id: string;
    title: string;
    groupId: string | null;
    tags: string[];
    hasAnswer: boolean;
  }[];
  totalQuestions: number;
};
export type TrashedQuestion = {
  id: string;
  title: string;
  deckId: string | null;
  deckTitle: string;
  deletedAt: string;
  expiresAt: string;
};
export type Workspace = {
  user: { id: string; name: string; email: string };
  decks: DeckView[];
  questions: QuestionView[];
  followedAuthors?: FollowedAuthorView[];
  stats: {
    due: number;
    new: number;
    reviewedToday: number;
    newLearnedToday: number;
    totalReviews: number;
    streak: number;
    total: number;
    retention: number | null;
  };
  activity: { date: string; count: number }[];
  recentReviews: {
    id: string;
    questionId: string;
    title: string;
    rating: number;
    answer: string | null;
    createdAt: string;
    due: string;
  }[];
  settings: {
    hasKey: boolean;
    keyHint: string;
    provider: string;
    baseUrl: string;
    model: string;
    dailyGoal: number;
    dailyNewLimit: number;
    theme: string;
    timeZone: string;
  };
};
type DeckDetails = Pick<DeckView, "title" | "description">;
export type ChatEdit =
  | {
      target: "question";
      id: string;
      revision: number;
      fields: Partial<Pick<QuestionView, "title" | "answer" | "tags">>;
    }
  | {
      target: "deck";
      id: string;
      expected: DeckDetails;
      fields: Partial<DeckDetails>;
    }
  | {
      target: "note";
      id: string;
      expectedVersion: number;
      fields: { note: string };
    };
export type ChatToolStep = {
  name: string;
  label: string;
};
export type ChatQuestionReference = {
  id: string;
  title: string;
  deckTitle: string;
};
export type ChatMessageMeta = {
  reasoning?: string;
  toolSteps?: ChatToolStep[];
  references?: ChatQuestionReference[];
};
export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  edits?: ChatEdit[] | null;
  reasoning?: string;
  toolSteps?: ChatToolStep[];
  references?: ChatQuestionReference[];
  createdAt: string;
};
export type ConversationScope = "question" | "deck" | "workspace";
export type Conversation = {
  id: string;
  scope?: ConversationScope;
  deckId?: string | null;
  questionId: string | null;
  quote: string;
  attempt: string;
  questionTitle: string;
  answerSnapshot: string;
  questionRevision: number;
  createdAt: string;
  messages: ChatMessage[];
};
