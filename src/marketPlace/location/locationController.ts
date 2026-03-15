import { checkAuth } from "../../webhook/utils/auth";
import { prisma } from "../../prisma";


const getStates = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const states = await prisma.locationState.findMany({
      orderBy: { name: "asc" },
    });
    res.json(states);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getLgas = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { stateId } = req.params;
    const lgas = await prisma.locationLga.findMany({
      where: { stateId },
      orderBy: { name: "asc" },
    });
    res.json(lgas);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getAreas = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { lgaId } = req.params;
    const areas = await prisma.locationArea.findMany({
      where: { lgaId },
      orderBy: { name: "asc" },
    });
    res.json(areas);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getStreets = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { areaId } = req.params;
    const streets = await prisma.locationStreet.findMany({
      where: { areaId },
      orderBy: { name: "asc" },
    });
    res.json(streets);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getFullHierarchy = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const states = await prisma.locationState.findMany({
      include: {
        lgas: {
          include: {
            areas: {
              include: { streets: true },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    res.json(states);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default { getStates, getLgas, getAreas, getStreets, getFullHierarchy };
