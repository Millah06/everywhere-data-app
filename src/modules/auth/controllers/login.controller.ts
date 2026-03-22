 
import { getAuth } from "firebase-admin/auth";
import { prisma } from "../../../prisma";

/**
 * POST /auth/login
 * Verifies the Firebase ID token sent by the client (after client-side signInWithEmailAndPassword)
 * and returns the Postgres user profile.
 * Body: { idToken }
 */
export const login = async (req: any, res: any) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: "idToken is required." });

    const decoded = await getAuth().verifyIdToken(idToken);

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        active: true,
        referralCode: true,
        notificationsEnabled: true,
        kyc: { select: { status: true } },
        wallet: {
          select: {
            fiat: { select: { availableBalance: true, lockedBalance: true, rewardBalance: true } },
          },
        },
        userProfile: {
          select: { avatarUrl: true, isVerified: true, badges: true },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User record not found. Please register." });
    }

    if (!user.active) {
      return res.status(403).json({ message: "Account suspended. Contact support." });
    }

    return res.json({ user });
  } catch (e: any) {
    return res.status(401).json({ message: "Invalid or expired token.", error: e.message });
  }
};

/**
 * POST /auth/refresh-claims
 * Re-syncs Firebase custom claims from Postgres (role changes etc.)
 * Protected — requires valid token.
 */
export const refreshClaims = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Missing token." });
    }
    const decoded = await getAuth().verifyIdToken(authHeader.split("Bearer ")[1]);

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { id: true, role: true },
    });

    if (!user) return res.status(404).json({ message: "User not found." });

    await getAuth().setCustomUserClaims(decoded.uid, { role: user.role, postgresId: user.id });

    return res.json({ message: "Claims refreshed. Ask client to force-refresh the ID token." });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    login,
    refreshClaims
}