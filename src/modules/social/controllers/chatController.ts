import admin from 'firebase-admin';

const createdOrGetChat = async (req: any, res: any) => {
  try {
    const { userId } = req.body;
  }
  catch (error) {    console.error('Error creating or getting chat:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

export default { createdOrGetChat };