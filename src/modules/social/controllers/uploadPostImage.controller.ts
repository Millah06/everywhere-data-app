import { uploadImage, uploadMultipleImages } from "../../../shared/services/uploadImage.service";
// Your simple upload function - JUST LIKE YOUR createPost!
export const uploadPostImages = async (req: any, res: any) => {
  try {
    // Check auth first (just like your createPost)
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Check if file exists (multer adds it to req.file)
     if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No images added." });
    }

    let imageUrls: string[] = [];
    
    if (req.files.length > 1) {
      imageUrls = await uploadMultipleImages(
        req.files,
        userId,
        'post',
      );

       
    } else {
      const imageUrl = await uploadImage(
        req.files[0],
        userId,
        'post',
      );
      imageUrls = [imageUrl];
    }
    
    res.status(200).json({
      success: true,
      urls: imageUrls, // Same format as your Firebase function returned
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