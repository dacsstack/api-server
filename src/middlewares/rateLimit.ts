import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { getAuthContext } from "../lib/auth";

export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
  skip: (req) => req.method === "OPTIONS",
});

export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please wait 1 minute" },
  skipSuccessfulRequests: true,
});

export const registerRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts, please wait 1 minute" },
});

export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const ctx = getAuthContext(req);
    return ctx?.userId ?? "anon";
  },
  validate: { xForwardedForHeader: false },
  message: { error: "AI request limit reached, please wait 1 minute" },
});
