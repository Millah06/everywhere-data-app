

// lib/prisma.ts
import { PrismaClient } from "@prisma/client";

declare global {
  // Prevent multiple instances in development
  var prisma: PrismaClient | undefined;
}

// Pass DATABASE_URL explicitly if needed
const prisma = global.prisma ?? new PrismaClient({});

if (process.env.NODE_ENV !== "production") global.prisma = prisma;

export { prisma };