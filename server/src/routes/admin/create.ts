import { Router } from "express";
import { getDb } from "../../db.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { createInstanceSchema, provisionInstance, HttpError } from "../../services/provisioning.js";
import { ProviderError } from "../../services/virtualization/provider.js";

export const adminCreateRouter = Router();
adminCreateRouter.use(requireAuth, requireAdmin);

adminCreateRouter.post("/", validate(createInstanceSchema), async (req, res) => {
  const db = getDb();
  try {
    const result = await provisionInstance(db, req.body, req.user!.id);
    res.status(201).json({ data: { instance: result.instance } });
  } catch (err) {
    if (err instanceof ProviderError || err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(502).json({ error: { code: "CREATE_FAILED", message: "Container creation failed." } });
  }
});
