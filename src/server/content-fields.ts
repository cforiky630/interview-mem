import { z } from "zod";
import { MAX_FOLDER_TITLE_LENGTH, validateFolderTitle } from "@/lib/folders";

export const folderTitleSchema = z
  .string()
  .trim()
  .min(1, "请输入文件夹名称。")
  .max(MAX_FOLDER_TITLE_LENGTH, `文件夹名称最多 ${MAX_FOLDER_TITLE_LENGTH} 个字符。`)
  .superRefine((value, ctx) => {
    const err = validateFolderTitle(value);
    if (err) {
      ctx.addIssue({ code: "custom", message: err });
    }
  });

export const deckFields = {
  title: folderTitleSchema,
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
