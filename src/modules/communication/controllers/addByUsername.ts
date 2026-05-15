import { prisma } from "../../../prisma";

export const findByUsername = async (req: any, res: any) => {

    try {

        const { username } = req.query;

        if (!username) {
            return res.status(400).json({
                message: 'Username is required'
            });
        }

        const user = await prisma.userProfile.findFirst({
            where: {
                userName: {
                    equals: String(username).trim(),
                    mode: 'insensitive'
                }
            },
            include: {
                user: {
                    select: {
                        firebaseUid: true,
                        name: true,
                        phone: true,
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({
                message: 'User not found'
            });
        }

        return res.json({
            user: {
                uid: user.user.firebaseUid,
                name: user.user.name,
                phone: user.user.phone,
                userName: user.userName,
                avatarUrl: user.avatarUrl,
                verified: user.isVerified,
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
    findByUsername
}