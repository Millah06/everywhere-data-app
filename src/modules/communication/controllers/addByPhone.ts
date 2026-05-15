import { prisma } from "../../..//prisma";

export const findByPhone = async (req: any, res: any) => {

    try {

        const { phone } = req.query;

        if (!phone) {
            return res.status(400).json({
                message: 'Phone number is required'
            });
        }

        const normalizedPhone = String(phone)
            .replace(/\s+/g, '')
            .trim();

        const user = await prisma.user.findFirst({
            where: {
                phone: normalizedPhone
            },
            include: {
                userProfile: true
            }
        });

        if (!user) {
            return res.status(404).json({
                message: 'User not found'
            });
        }

        return res.json({
            user: {
                uid: user.firebaseUid,
                name: user.name,
                phone: user.phone,
                userName: user.userProfile?.userName,
                avatarUrl: user.userProfile?.avatarUrl,
                verified: user.userProfile?.isVerified,
            }
        });

    } catch (error) {

        console.log(error);

        return res.status(500).json({
            message: 'Something went wrong'
        });
    }
}

export default {
    findByPhone
}