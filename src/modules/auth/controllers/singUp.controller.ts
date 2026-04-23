 
import { getAuth } from "firebase-admin/auth";
import { prisma } from "../../../prisma";
import { generateReferralCode } from "../../../shared/utils/generateRefferalCode";
 
import { generate11DigitId } from "../../../transferUid";
import {nanoid} from 'nanoid';

/**
 * POST /auth/register
 * Creates a Firebase user AND a Postgres User row in one call.
 * Body: { name, email, password, phone?, referralCode? }
 */
export const register = async (req: any, res: any) => {
  try {
    const { name, email, password, phone, referralCode } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required." });
    }

    // 1. Create Firebase user
    const firebaseUser = await getAuth().createUser({
      email,
      password,
      displayName: name,
      ...(phone ? { phoneNumber: phone } : {}),
    });

    // 2. Validate referral code if provided
    let referredByCode: string | undefined;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
      if (!referrer) {
        // Don't hard-fail — just ignore invalid referral codes
        console.warn(`Invalid referral code: ${referralCode}`);
      } else {
        referredByCode = referralCode;
      }
    }

    // 3. Create Postgres user (minimal fields — rest filled later)
    const user = await prisma.user.create({
      data: {
        firebaseUid: firebaseUser.uid,
        transferUid: generate11DigitId(),
        name,
        email,
        phone: phone ?? "",
        referralCode: generateReferralCode(),
        referredBy: referredByCode,
        // Create wallet and fiat sub-records immediately
        wallet: {
          create: {
            fiat: {
              create: {
                availableBalance: 0,
                lockedBalance: 0,
                rewardBalance: 0,
              },
            },
          },
        },
        // Create bare user profile
        userProfile: {
          create: {
            userName: `user_${nanoid(8)}`
          },
        },
      }, 
      select: {
        id: true,
        name: true,
        email: true,
        firebaseUid: true,
        role: true,
        referralCode: true,
        createdAt: true,
      },
    });

    // 4. Set custom claims on Firebase so role is available in token
    await getAuth().setCustomUserClaims(firebaseUser.uid, { role: user.role, postgresId: user.id });

    // 5. Return a custom tok en the client can exchange for an ID token
    const customToken = await getAuth().createCustomToken(firebaseUser.uid, {
      role: user.role,
    });

    return res.status(201).json({ user, customToken });
  } catch (e: any) {
    if (e.code === "auth/email-already-exists") {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    return res.status(500).json({ message: e.message });
  }
};

export default {
    register
}