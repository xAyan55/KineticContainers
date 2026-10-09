import { z } from "zod";
import type { NextFunction, Request, Response } from "express";

export function validate<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION",
          message: "Invalid request.",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export const emailSchema = z.string().email().max(254).transform((s) => s.trim().toLowerCase());

export function passwordSchema(minLen: number): z.ZodString {
  return z.string().min(minLen, `Password must be at least ${minLen} characters.`).max(256);
}
