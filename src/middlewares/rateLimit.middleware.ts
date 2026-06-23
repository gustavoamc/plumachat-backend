import { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  // Epoch ms when the current window expires and the count resets.
  resetAt: number;
}

/**
 * Lightweight in-memory rate limiter keyed by client IP.
 *
 * Good enough to protect public endpoints (e.g. registration) from scanning
 * and brute force without pulling in an extra dependency. State is per-process,
 * so behind multiple instances each process keeps its own counters.
 *
 * @param options.windowMs Size of the sliding window in milliseconds.
 * @param options.max Maximum number of requests allowed per window per IP.
 * @param options.message Optional custom message returned on 429.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const { windowMs, max, message } = options;
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        message:
          message ||
          "Muitas requisições. Tente novamente em alguns instantes.",
      });
    }

    // Opportunistic cleanup so the map doesn't grow unbounded.
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) {
        if (now > b.resetAt) buckets.delete(k);
      }
    }

    next();
  };
}
