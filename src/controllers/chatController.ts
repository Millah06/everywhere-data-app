import admin from 'firebase-admin';
import { checkAuth } from '../webhook/utils/auth';

const createdOrGetChat = async (req: any, res: any) => {
  try {
    const { userId } = req.body;
    const { postId } = req.body;
  }
  catch (error) {    console.error('Error creating or getting chat:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

export default { createdOrGetChat };