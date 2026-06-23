import { registerUser, loginUser } from "../controllers/auth.controller";
import { rateLimit } from "../middlewares/rateLimit.middleware";

const router = require('express').Router()

// "Auth" are routes that don't need authentication, like "reset password" and "register"

// Basic hygiene against invite-code scanning / brute force on registration.
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.post('/register', registerLimiter, registerUser)
router.post('/login', loginUser)
//TODO: reset password

export default router