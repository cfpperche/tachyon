import { z } from "zod";

const reviewCommand = z.object({
  taskId: z.string().regex(/^t-[0-9a-f]{6}$/),
  prototypeId: z.string().regex(/^p-[0-9a-f]{12}$/),
  action: z.enum(["approve", "reject", "note"]),
  expectUpdatedAt: z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp"),
  review: z.string().refine((value) => value.trim().length > 0 && [...value].length <= 4_000, "invalid review").optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "note" && value.review === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "note requires review" });
  }
});

export type TaskPrototypeReviewInputV1 = z.infer<typeof reviewCommand>;

export function parseTaskPrototypeReviewInputV1(value: unknown): TaskPrototypeReviewInputV1 {
  return reviewCommand.parse(value);
}

export function isTaskPrototypeReviewInputV1(value: unknown): value is TaskPrototypeReviewInputV1 {
  return reviewCommand.safeParse(value).success;
}
