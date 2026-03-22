import { prisma } from "../../../prisma";

/** Resolve route param that may be Prisma User.id or Firebase UID. */
export async function resolveUserId(param: string): Promise<string | null> {
  const u = await prisma.user.findFirst({
    where: { OR: [{ id: param }, { firebaseUid: param }] },
    select: { id: true },
  });
  return u?.id ?? null;
}
