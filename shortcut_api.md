# Shortcut API (TypeScript + Express + Mongoose + Swagger)

## 1. `models/shortcut.model.ts`
```ts
import mongoose, { Document, Schema, Model } from "mongoose";

export interface IShortcut extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  type: string;
  address: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
}

const ShortcutSchema: Schema<IShortcut> = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    location: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
    },
  },
  { timestamps: true }
);

ShortcutSchema.index({ location: "2dsphere" });

export const Shortcut: Model<IShortcut> = mongoose.model<IShortcut>("Shortcut", ShortcutSchema);
```

## 2. `services/shortcut.service.ts`
```ts
import { Shortcut } from "../models/shortcut.model";

export const createShortcut = async (payload: any) => {
  try {
    const newShortcut = await Shortcut.create({
      userId: payload.userId,
      name: payload.name,
      type: payload.type,
      address: payload.address,
      location: {
        type: "Point",
        coordinates: [payload.longitude, payload.latitude],
      },
    });

    return { status: true, data: newShortcut, message: "Shortcut created successfully" };
  } catch (error: any) {
    return { status: false, data: [], message: error.message || "Something went wrong" };
  }
};

export const updateShortcut = async (id: string, payload: any) => {
  try {
    if (payload.longitude !== undefined && payload.latitude !== undefined) {
      payload.location = {
        type: "Point",
        coordinates: [payload.longitude, payload.latitude],
      };
      delete payload.longitude;
      delete payload.latitude;
    }

    const updatedShortcut = await Shortcut.findByIdAndUpdate(id, { $set: payload }, { new: true });

    if (!updatedShortcut) return { status: false, data: [], message: "Shortcut not found" };

    return { status: true, data: updatedShortcut, message: "Shortcut updated successfully" };
  } catch (error: any) {
    return { status: false, data: [], message: error.message || "Something went wrong" };
  }
};

export const getShortcuts = async (userId: string) => {
  try {
    const shortcuts = await Shortcut.find({ userId }).lean();
    return { status: true, data: shortcuts, message: "Shortcuts fetched successfully" };
  } catch (error: any) {
    return { status: false, data: [], message: error.message || "Something went wrong" };
  }
};
```

## 3. `controllers/shortcut.controller.ts`
```ts
import { Request, Response } from "express";
import { createShortcut, updateShortcut, getShortcuts } from "../services/shortcut.service";

export const createShortcutController = async (req: Request, res: Response) => {
  const result = await createShortcut(req.body);
  return res.status(result.status ? 200 : 400).json(result);
};

export const updateShortcutController = async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await updateShortcut(id, req.body);
  return res.status(result.status ? 200 : 400).json(result);
};

export const getShortcutsController = async (req: Request, res: Response) => {
  const { userId } = req.params;
  const result = await getShortcuts(userId);
  return res.status(result.status ? 200 : 400).json(result);
};
```

## 4. `routes/shortcut.routes.ts`
```ts
import { Router } from "express";
import {
  createShortcutController,
  updateShortcutController,
  getShortcutsController,
} from "../controllers/shortcut.controller";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Shortcuts
 *   description: Manage user map shortcuts
 */

/**
 * @swagger
 * /shortcuts:
 *   post:
 *     summary: Create a new shortcut
 *     tags: [Shortcuts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - name
 *               - type
 *               - address
 *               - longitude
 *               - latitude
 *             properties:
 *               userId:
 *                 type: string
 *                 example: 64f8b6e43e3e3d92b3d1b91a
 *               name:
 *                 type: string
 *                 example: Home
 *               type:
 *                 type: string
 *                 example: Residential
 *               address:
 *                 type: string
 *                 example: 123 Main Street
 *               longitude:
 *                 type: number
 *                 example: 77.5946
 *               latitude:
 *                 type: number
 *                 example: 12.9716
 *     responses:
 *       200:
 *         description: Shortcut created successfully
 */
router.post("/", createShortcutController);

/**
 * @swagger
 * /shortcuts/{id}:
 *   put:
 *     summary: Update a shortcut
 *     tags: [Shortcuts]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: Shortcut ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               type: { type: string }
 *               address: { type: string }
 *               longitude: { type: number }
 *               latitude: { type: number }
 *     responses:
 *       200:
 *         description: Shortcut updated successfully
 */
router.put("/:id", updateShortcutController);

/**
 * @swagger
 * /shortcuts/user/{userId}:
 *   get:
 *     summary: Get all shortcuts for a user
 *     tags: [Shortcuts]
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: string
 *         required: true
 *         description: User ID
 *     responses:
 *       200:
 *         description: Shortcuts fetched successfully
 */
router.get("/user/:userId", getShortcutsController);

export default router;
```

## 5. Example `server.ts`
```ts
import express from "express";
import mongoose from "mongoose";
import swaggerJsDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import shortcutRoutes from "./routes/shortcut.routes";

const app = express();
app.use(express.json());

// Swagger setup
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: { title: "Shortcut API", version: "1.0.0" },
  },
  apis: ["./routes/*.ts"],
};
const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Routes
app.use("/shortcuts", shortcutRoutes);

// Connect DB & start server
mongoose
  .connect("mongodb://localhost:27017/shortcutsdb")
  .then(() => {
    console.log("MongoDB connected");
    app.listen(5000, () => console.log("Server running at http://localhost:5000"));
  })
  .catch((err) => console.error(err));
```
