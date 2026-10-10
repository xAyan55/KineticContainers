import { z } from "zod";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      /** Result of `validateQuery`; parsed and coerced query parameters. */
      validatedQuery?: Record<string, unknown>;
    }
  }
}

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

/** Query-parameter validation. Express exposes `req.query` as a getter, so the
 * parsed result is stored on `req.validatedQuery` instead of being assigned. */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION",
          message: "Invalid query parameters.",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    req.validatedQuery = parsed.data as Record<string, unknown>;
    next();
  };
}

export const emailSchema = z.string().email().max(254).transform((s) => s.trim().toLowerCase());

export function passwordSchema(minLen: number): z.ZodString {
  return z.string().min(minLen, `Password must be at least ${minLen} characters.`).max(256);
}
