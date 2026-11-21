import { z } from "zod";

export const deckFields = {
  title: z.string().trim().min(1).max(80),
  description: z.string().max(500),
};

export const questionFields = {
  title: z.string().trim().min(1).max(200),
  answer: z.string().max(100_000),
  tags: z.array(z.string().trim().min(1).max(30)).max(12),
};

export const noteFields = {
  note: z.string().max(50_000),
};
