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

const uploadMenuItemImages = async (req: any, res: any) => {
  try {

    const userId = req.user?.id;

    const { itemId } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No images added." });
    }

    const item = await prisma.menuItem.findUnique({
      where: { id: itemId },
      include: { branch: { include: { vendor: true } } },
    });
    if (!item) return res.status(404).json({ message: "Menu item not found" });
    if (item.branch.vendor.ownerId !== userId && item.branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    if (req.files.length > 1) {
      const imageUrls = await uploadMultipleImages(
        req.files,
        userId,
        'menuItem',
      );

       await prisma.menuItem.update({ where: { id: itemId }, data: { images: imageUrls } });
    } else {
      const imageUrl = await uploadImage(
        req.files[0],
        userId,
        'menuItem',
      );
      await prisma.menuItem.update({ where: { id: itemId }, data: { images: [imageUrl] } });
    }
    
     res.json({ success: true, message: "Menu item images uploaded successfully" });

  } catch (e: any) {
    console.error("Error uploading menu item images:", e.message);
    res
      .status(500)
      .json({
        error: `An error occurred while uploading menu item images. ${e.message}`,
      });
  }
};

export default {
  uploadVendorLogo,
  uploadVendorCoverImage,
  uploadCacCertificate,
  uploadMenuItemImages,
};
