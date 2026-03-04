import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
// import { PrismaClient } from "../generated/prisma/client";

// const connectionString = `${process.env.DATABASE_URL}`;

// const adapter = new PrismaPg({ connectionString });
// const prisma = new PrismaClient({ adapter });

// export { prisma };

// If your schema.prisma has a custom `output` path in the generator block,
// change the import below to match it. e.g.:
//   output = "../generated/prisma/client"  →  import { PrismaClient } from "../generated/prisma/client"
// Otherwise the default @prisma/client works after running: npx prisma generate

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;