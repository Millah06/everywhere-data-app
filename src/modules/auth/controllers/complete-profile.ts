import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';

/**
 * POST /auth/complete-profile
 * Called after signup (SecurityStep1Screen).
 * Updates phone number on Firebase + Prisma, validates + links referral code.
 * Requires valid Firebase ID token in Authorization header.
 */
export const completeProfile = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing authorization token.' });
    }
    const decoded = await getAuth().verifyIdToken(
      authHeader.replace('Bearer ', '')
    );

    const { phone, countryCode, referralCode } = req.body;

    if (!phone) {
      return res.status(400).json({ message: 'phone is required.' });
    }

    // 1. Update Firebase user with phone number
    try {
      await getAuth().updateUser(decoded.uid, { phoneNumber: phone });
    } catch (firebaseErr: any) {
      // Phone already in use by another account, or invalid format
      if (
        firebaseErr.code === 'auth/phone-number-already-exists' ||
        firebaseErr.code === 'auth/invalid-phone-number'
      ) {
        return res.status(400).json({ message: firebaseErr.message });
      }
      // Non-critical — log and continue (phone on Firebase is optional)
      console.warn('[completeProfile] Firebase phone update failed:', firebaseErr.message);
    }

    // 2. Validate referral code if provided
    let referredBy: string | undefined;
    if (referralCode?.trim()) {
      const referrer = await prisma.user.findUnique({
        where: { referralCode: referralCode.trim().toUpperCase() },
        select: { id: true, referralCode: true },
      });
      if (referrer) {
        referredBy = referrer.referralCode ?? undefined;
      }
      // Silently ignore invalid referral codes — don't block setup
    }

    // 3. Update Prisma user
    const updatedUser = await prisma.user.update({
      where: { firebaseUid: decoded.uid },
      data: {
        phone,
        ...(countryCode ? { country: countryCode } : {}),
        ...(referredBy ? { referredBy } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        country: true,
        currency: true,
      },
    });

    return res.json({ user: updatedUser, message: 'Profile updated.' });
  } catch (e: any) {
    console.error('[completeProfile]', e);
    return res.status(500).json({ message: e.message });
  }
};

export default { completeProfile };