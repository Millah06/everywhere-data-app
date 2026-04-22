import { prisma } from "../../../prisma";
import  { uploadImage, uploadMultipleImages } from "../../../shared/services/uploadImage.service";

const uploadVendorLogo = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const imageUrl = await uploadImage(req.file, userId, "vendorLogo");

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { logo: imageUrl },
    });

    res.json({ success: true, imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const uploadVendorCoverImage = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const imageUrl = await uploadImage(req.file, userId, "vendorCover");

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { coverPhoto: imageUrl },
    });

    res.json({ success: true, imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};



const uploadCacCertificate = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    
    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const imageUrl = await uploadImage(
      req.file,
      userId,
      "cacCertificate"
    );

    // Store on vendor — add cacCertificateUrl field to schema
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { cacCertificateUrl: imageUrl },
    });

    res.json({ url: imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

// Your simple upload function - JUST LIKE YOUR createPost!
const uploadMenuItemImages = async (req: any, res: any) => {
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
        'menuItems',
      );

       
    } else {
      const imageUrl = await uploadImage(
        req.files[0],
        userId,
        'menuItems',
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

export default {
  uploadVendorLogo,
  uploadVendorCoverImage,
  uploadCacCertificate,
  uploadMenuItemImages,
};
