import helmet from "helmet";
import type { Request, Response, NextFunction } from "express";

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https:"],
        fontSrc: ["'self'", "https:", "data:"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  });
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const mutating = ["POST", "PUT", "PATCH", "DELETE"];
  if (!mutating.includes(req.method)) {
    next();
    return;
  }

  // Bearer token auth (mobile / API clients) is not vulnerable to CSRF — skip the check.
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    next();
    return;
  }

  const origin = req.headers.origin;
  const host = req.headers.host ?? "";

  if (!origin) {
    next();
    return;
  }

  try {
    const originHost = new URL(origin).host;
    if (originHost === host) {
      next();
      return;
    }
    // Allow all *.replit.dev and *.replit.app subdomains (Expo preview, web preview, production).
    if (originHost.endsWith(".replit.dev") || originHost.endsWith(".replit.app") || originHost.endsWith(".expo.sisko.replit.dev")) {
      next();
      return;
    }
    const allowedOrigins = (process.env.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    if (allowedOrigins.some((d) => originHost === d || originHost.endsWith("." + d))) {
      next();
      return;
    }
    res.status(403).json({ error: "CSRF check failed" });
  } catch {
    res.status(403).json({ error: "CSRF check failed" });
  }
}
