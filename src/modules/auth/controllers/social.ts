import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';
import { generateReferralCode } from '../../../shared/utils/generateRefferalCode';
import { generate11DigitId } from '../../../transferUid';
import { nanoid } from 'nanoid';
import { detectRegion } from '../../../shared/utils/ip-region';

const USER_SELECT = {
  id: true, name: true, email: true, phone: true,
  role: true, active: true, referralCode: true, firebaseUid: true,
  country: true, currency: true, notificationsEnabled: true,
  kyc: { select: { status: true } },
  wallet: {
    select: {
      fiat: { select: { availableBalance: true, lockedBalance: true, rewardBalance: true } },
    },
  },
  userProfile: { select: { avatarUrl: true, isVerified: true, badges: true } },
} as const;

/**
 * POST /auth/social
 * Handles Google + Apple. Upserts the user: logs in if existing, creates if new.
 * Body: { idToken, provider: 'google'|'apple', name?, email? }
 */
export const socialAuth = async (req: any, res: any) => {
  try {
    const { idToken, provider, name, email } = req.body;

    if (!idToken || !provider) {
      return res.status(400).json({ message: 'idToken and provider are required.' });
    }

    // 1. Verify Firebase token
    const decoded = await getAuth().verifyIdToken(idToken);

    // 2. Check for existing user
    const existingUser = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: USER_SELECT,
    });

    if (existingUser) {
      if (!existingUser.active) {
        return res.status(403).json({ message: 'Account suspended. Contact support.' });
      }
      return res.json({ user: existingUser, isNewUser: false });
    }

    // 3. New user — detect region, create record
    const region = detectRegion(req);

    const resolvedName =
      name?.trim() ||
      decoded.name ||
      (decoded.email ?? '').split('@')[0] ||
      'User';

    const resolvedEmail =
      email?.trim() ||
      decoded.email ||
      `${decoded.uid}@social.placeholder`;

    const newUser = await prisma.user.create({
      data: {
        firebaseUid: decoded.uid,
        transferUid: generate11DigitId(),
        name: resolvedName,
        email: resolvedEmail,
        phone: decoded.phone_number ?? '',
        referralCode: generateReferralCode(),
        country: region.country,
        currency: region.currency,
        timezone: region.timezone,
        wallet: {
          create: {
            fiat: {
              create: { availableBalance: 0, lockedBalance: 0, rewardBalance: 0 },
            },
          },
        },
        userProfile: {
          create: {
            userName: `user_${nanoid(8)}`,
            avatarUrl: decoded.picture ?? '',
          },
        },
      },
      select: USER_SELECT,
    });

    // 4. Set custom claims
    await getAuth().setCustomUserClaims(decoded.uid, {
      role: newUser.role,
      postgresId: newUser.id,
    });

    return res.status(201).json({ user: newUser, isNewUser: true });
  } catch (e: any) {
    console.error('[socialAuth]', e);
    return res.status(500).json({ message: e.message });
  }
};

export default { socialAuth };