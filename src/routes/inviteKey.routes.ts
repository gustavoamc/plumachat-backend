import {
  createInviteKeys,
  getInviteKeys,
  deleteInviteKey,
} from "../controllers/inviteKey.controller";
import { checkStatus } from "../middlewares/checkStatus.middleware";

const router = require("express").Router();

// Invite keys are managed by moderation staff (admin/root).
router.post("/", checkStatus(["root", "admin"]), createInviteKeys);
router.get("/", checkStatus(["root", "admin"]), getInviteKeys); // query param "used"
router.delete("/:keyId", checkStatus(["root", "admin"]), deleteInviteKey);

export default router;
