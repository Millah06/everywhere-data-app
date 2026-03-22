import { NextFunction, Request, Response } from "express";
import * as admin from "firebase-admin";
import { prisma } from "../prisma";

type AppRole = "user" | "vendor" | "admin";

const extractBearerToken = (authHeader?: string): string | null => {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim() || null;
};

export const authMiddleware = async (
  req: any,
  res: any,
  next: NextFunction,
) => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const dbUser = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { id: true, role: true, active: true, email: true },
    });

    if (!dbUser) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    if (!dbUser.active) {
      return res
        .status(403)
        .json({ message: "Your account has been suspended. Contact support." });
    }

    req.user = {
      id: dbUser.id,
      uid: decoded.uid,
      email: dbUser.email ?? decoded.email ?? null,
      role: dbUser.role as AppRole,
    };

    return next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

export const requireRole =
  (...roles: AppRole[]) =>
  (req: any, res: any, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "You do not have this privilege. Please contact support." });
    }

    return next();
  };

export const requireAdmin = requireRole("admin");