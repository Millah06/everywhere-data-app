import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

// Just use DATABASE_URL from environment automatically
const client = new PrismaClient();

export const prisma = global.prisma ?? client;

if (process.env.NODE_ENV !== "production") global.prisma = prisma;