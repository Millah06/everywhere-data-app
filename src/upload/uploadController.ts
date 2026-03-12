import { checkAuth } from "../webhook/utils/auth";
import { prisma } from "../prisma";
import { uploadImage} from "../cludfareServices/uploadImage";



const uploadVendorLogo = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const imageUrl = await uploadImage(req.file, userId, 'vendorLogo');

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
    const userId = await checkAuth(req);

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const imageUrl = await uploadImage(req.file, userId, 'vendorCover');

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { coverPhoto : imageUrl },
    });

    res.json({ success: true, imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const uploadMenuItemImage = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { itemId } = req.params;

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const item = await prisma.menuItem.findUnique({
      where: { id: itemId },
      include: { branch: { include: { vendor: true } } },
    });
    if (!item) return res.status(404).json({ message: "Menu item not found" });
    if (item.branch.vendor.ownerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const imageUrl = await uploadImage(req.file, userId, 'menuItem');;

    await prisma.menuItem.update({ where: { id: itemId }, data: { imageUrl} });

    res.json({ success: true, imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default { uploadVendorLogo, uploadMenuItemImage, uploadVendorCoverImage };
