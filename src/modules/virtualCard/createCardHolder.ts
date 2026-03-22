import admin from "firebase-admin";

const createCardHolder = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { firstName, lastName, email, phoneNumber, dateOfBirth,} = req.body;
    // const cardHolder = await prisma.cardHolder.create({
    //   data: {
    //     userId,
    //     name,
    //     email
    //   }
    // });

    res.status(201).json({});
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  createCardHolder
};
