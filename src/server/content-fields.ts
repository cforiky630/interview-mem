import { z } from "zod";

export const deckFields = {
  title: z.string().trim().min(1).max(80),
  description: z.string().max(500),
};

export const deckGroupNameSchema = z.string().trim().max(40);

export const deckGroupFields = {
  title: z.string().trim().min(1, "请输入分组名称。").max(80),
  category: z.string().trim().max(40).default(""),
  description: z.string().trim().max(300).default(""),
};

export const questionFields = {
  title: z.string().trim().min(1).max(200),
  answer: z.string().max(100_000),
  tags: z.array(z.string().trim().min(1).max(30)).max(12),
};

export const noteFields = {
  note: z.string().max(50_000),
};
