import { uploadImage } from "../../../shared/services/uploadImage.service";
// Your simple upload function - JUST LIKE YOUR createPost!
export const uploadPostImage = async (req: any, res: any) => {
  try {
    // Check auth first (just like your createPost)
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Check if file exists (multer adds it to req.file)
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    const imageUrl = await uploadImage(req.file, userId, "post");

    res.status(200).json({
      success: true,
      url: imageUrl, // Same format as your Firebase function returned
      message: "Image uploaded successfully",
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({
      error: "Failed to upload image",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};