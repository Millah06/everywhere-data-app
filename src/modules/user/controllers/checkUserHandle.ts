import { prisma } from "../../..//prisma";

const checkUserHandle = async (req: any, res: any) => {

    const { userHandle } = req.params;

    const existing = await prisma.userProfile.findUnique({
        where: {
            userName: userHandle
        }
    })

    if (existing) {
        return res.json({
            available: false,
            message: 'Handle already taken'
        });
    }

    return res.json({
         available: true,
        message: 'Handle is available'
    })
}

export default {
    checkUserHandle
}