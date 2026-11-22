
import express from "express";
import { getDB } from "../config/mongodb.js";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

// Get the logged-in user's profile
router.get("/me", verifyToken, async (req, res) => {
    try {
        const database = getDB();

        const user = await database.collection("user").findOne(
            { email: req.user.email },
            {
                projection: {
                    name: 1,
                    email: 1,
                    role: 1,
                    image: 1,
                    phone: 1,
                    area: 1,
                    bio: 1,
                    createdAt: 1,
                },
            }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User profile not found",
            });
        }

        return res.status(200).json({
            success: true,
            data: user,
        });

    } catch (error) {
        console.error("Get profile error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to get profile",
        });
    }
});

// Update the logged-in user's profile
router.patch("/me", verifyToken, async (req, res) => {
    try {
        const { name, phone, area, bio, image } = req.body;

        if (typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Name is required",
            });
        }

        if (
            (phone !== undefined && typeof phone !== "string") ||
            (area !== undefined && typeof area !== "string") ||
            (bio !== undefined && typeof bio !== "string") ||
            (image !== undefined && typeof image !== "string")
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid profile information",
            });
        }

        // Validate avatar URL if provided
        if (image) {
            try {
                const imageUrl = new URL(image);

                if (imageUrl.protocol !== "https:") {
                    throw new Error("Invalid image URL");
                }
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid HTTPS image URL",
                });
            }
        }

        if (image && image.length > 2048) {
            return res.status(400).json({
                success: false,
                message: "Image URL is too long",
            });
        }

        const database = getDB();

        const updateData = {
            name: name.trim(),
            phone: (phone || "").trim(),
            area: (area || "").trim(),
            bio: (bio || "").trim(),
            updatedAt: new Date(),
        };

        // Update image only when it is provided
        if (image !== undefined) {
            updateData.image = image.trim();
        }

        const result = await database.collection("user").updateOne(
            { email: req.user.email },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "User profile not found",
            });
        }

        const updatedUser = await database.collection("user").findOne(
            { email: req.user.email },
            {
                projection: {
                    name: 1,
                    email: 1,
                    role: 1,
                    image: 1,
                    phone: 1,
                    area: 1,
                    bio: 1,
                    createdAt: 1,
                },
            }
        );

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: updatedUser,
        });

    } catch (error) {
        console.error("Update profile error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to update profile",
        });
    }
});

export default router;
