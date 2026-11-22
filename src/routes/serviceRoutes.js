
import express from "express";
import { ObjectId } from "mongodb";
import multer from "multer";

import { getDB } from "../config/mongodb.js";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

const allowedCategories = [
    "Smartphone",
    "Laptop & PC",
    "AC",
    "Refrigerator",
    "TV",
    "Washing Machine",
    "Electrical",
    "Other",
];

const allowedServiceModes = [
    "Home Visit",
    "Shop Drop-off",
];

// ============================================
// IMAGE UPLOAD CONFIGURATION
// ============================================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (req, file, callback) => {
        if (!file.mimetype.startsWith("image/")) {
            return callback(new Error("Only image files are allowed"));
        }

        callback(null, true);
    },
});

// ============================================
// VERIFY TECHNICIAN
// ============================================

function verifyTechnician(req, res, next) {
    if (req.user?.role !== "technician") {
        return res.status(403).json({
            success: false,
            message: "Only technicians can perform this action",
        });
    }

    next();
}

// ============================================
// VERIFY CUSTOMER
// ============================================

function verifyCustomer(req, res, next) {
    if (req.user?.role !== "customer") {
        return res.status(403).json({
            success: false,
            message: "Only customers can save services",
        });
    }

    next();
}

// ============================================
// VALIDATE SERVICE ID
// ============================================

function isValidServiceId(id) {
    return (
        ObjectId.isValid(id) &&
        String(new ObjectId(id)) === id
    );
}

// ============================================
// VALIDATE SERVICE FORM
// ============================================

function validateServiceData(body) {
    const {
        title,
        category,
        description,
        image,
        basePrice,
        estimatedDuration,
        serviceMode,
        serviceArea,
    } = body;

    if (
        typeof title !== "string" ||
        !title.trim() ||
        typeof category !== "string" ||
        typeof description !== "string" ||
        !description.trim() ||
        typeof image !== "string" ||
        !image.trim() ||
        basePrice === undefined ||
        typeof estimatedDuration !== "string" ||
        !estimatedDuration.trim() ||
        typeof serviceMode !== "string" ||
        typeof serviceArea !== "string" ||
        !serviceArea.trim()
    ) {
        return {
            valid: false,
            message: "All service fields are required",
        };
    }

    const price = Number(basePrice);

    if (!Number.isFinite(price) || price <= 0) {
        return {
            valid: false,
            message: "Base price must be a positive number",
        };
    }

    if (!allowedCategories.includes(category)) {
        return {
            valid: false,
            message: "Invalid service category",
        };
    }

    if (!allowedServiceModes.includes(serviceMode)) {
        return {
            valid: false,
            message: "Invalid service mode",
        };
    }

    let imageUrl;

    try {
        imageUrl = new URL(image.trim());

        if (imageUrl.protocol !== "https:") {
            throw new Error("Invalid image URL");
        }
    } catch {
        return {
            valid: false,
            message: "Please provide a valid HTTPS image URL",
        };
    }

    return {
        valid: true,
        data: {
            title: title.trim(),
            category,
            description: description.trim(),
            image: imageUrl.toString(),
            basePrice: price,
            estimatedDuration: estimatedDuration.trim(),
            serviceMode,
            serviceArea: serviceArea.trim(),
        },
    };
}

// ============================================
// UPLOAD SERVICE IMAGE TO IMGBB
// POST /api/services/upload-image
// TECHNICIAN ONLY
// ============================================

router.post(
    "/upload-image",
    verifyToken,
    verifyTechnician,
    upload.single("image"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Please select an image",
                });
            }

            const apiKey = process.env.IMGBB_API_KEY;

            if (!apiKey) {
                return res.status(500).json({
                    success: false,
                    message: "ImgBB API key is missing",
                });
            }

            const formData = new FormData();

            formData.append(
                "image",
                req.file.buffer.toString("base64")
            );

            const imgbbResponse = await fetch(
                `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`,
                {
                    method: "POST",
                    body: formData,
                }
            );

            const result = await imgbbResponse.json();

            if (!imgbbResponse.ok || !result.success) {
                console.error("ImgBB upload error:", result);

                return res.status(500).json({
                    success: false,
                    message: "Image upload to ImgBB failed",
                });
            }

            return res.status(200).json({
                success: true,
                message: "Image uploaded successfully",
                imageUrl: result.data.url,
            });

        } catch (error) {
            console.error("Image upload error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to upload image",
            });
        }
    }
);

// ============================================
// CREATE A NEW SERVICE
// POST /api/services
// TECHNICIAN ONLY
// NEW SERVICES ARE ALWAYS PENDING
// ============================================

router.post(
    "/",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const validation = validateServiceData(req.body);

            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: validation.message,
                });
            }

            const database = getDB();

            const technician = await database
                .collection("user")
                .findOne({
                    email: req.user.email,
                });

            if (!technician) {
                return res.status(404).json({
                    success: false,
                    message: "Technician account not found",
                });
            }

            const newService = {
                ...validation.data,

                technicianId: req.user.id,
                technicianName: technician.name,
                technicianEmail: technician.email,

                // Approval system
                approvalStatus: "pending",
                rejectionReason: "",

                isAvailable: true,
                isDeleted: false,

                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const result = await database
                .collection("services")
                .insertOne(newService);

            return res.status(201).json({
                success: true,
                message: "Service submitted for admin approval",
                data: {
                    ...newService,
                    _id: result.insertedId,
                },
            });

        } catch (error) {
            console.error("Create service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to create service",
            });
        }
    }
);

// ============================================
// CUSTOMER: ADD SERVICE TO MY LISTINGS
// POST /api/services/:id/add-list
// ONLY APPROVED SERVICES CAN BE SAVED
// ============================================

router.post(
    "/:id/add-list",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidServiceId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const database = getDB();

            const service = await database
                .collection("services")
                .findOne({
                    _id: new ObjectId(id),
                    approvalStatus: "approved",
                    isAvailable: true,
                    isDeleted: { $ne: true },
                });

            if (!service) {
                return res.status(404).json({
                    success: false,
                    message: "Approved service not found or unavailable",
                });
            }

            const savedCollection = database.collection(
                "customerSavedServices"
            );

            const existingSave = await savedCollection.findOne({
                serviceId: service._id,
                customerEmail: req.user.email,
            });

            if (existingSave) {
                return res.status(409).json({
                    success: false,
                    message: "This service is already in your My Listings",
                    data: existingSave,
                });
            }

            const newSave = {
                serviceId: service._id,
                customerEmail: req.user.email,
                savedAt: new Date(),
            };

            const result = await savedCollection.insertOne(newSave);

            return res.status(201).json({
                success: true,
                message: "Service saved to My Listings successfully",
                data: {
                    ...newSave,
                    _id: result.insertedId,
                },
            });

        } catch (error) {
            console.error("Save service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to save service",
            });
        }
    }
);

// ============================================
// CUSTOMER: GET MY LISTINGS
// GET /api/services/my-listings
// ONLY APPROVED SERVICES ARE RETURNED
// ============================================

router.get(
    "/my-listings",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const database = getDB();

            const savedServices = await database
                .collection("customerSavedServices")
                .find({
                    customerEmail: req.user.email,
                })
                .sort({
                    savedAt: -1,
                })
                .toArray();

            if (savedServices.length === 0) {
                return res.status(200).json({
                    success: true,
                    count: 0,
                    data: [],
                });
            }

            const serviceIds = savedServices.map(
                (saved) => saved.serviceId
            );

            const services = await database
                .collection("services")
                .find({
                    _id: { $in: serviceIds },
                    approvalStatus: "approved",
                    isDeleted: { $ne: true },
                })
                .toArray();

            const serviceMap = new Map(
                services.map((service) => [
                    service._id.toString(),
                    service,
                ])
            );

            const result = savedServices
                .map((saved) => {
                    const service = serviceMap.get(
                        saved.serviceId.toString()
                    );

                    if (!service) {
                        return null;
                    }

                    return {
                        ...service,

                        // Saved record ID
                        _id: saved._id,

                        // Original service ID
                        serviceId: service._id,

                        // ID used by the remove button
                        listingId: saved._id,

                        savedAt: saved.savedAt,
                    };
                })
                .filter(Boolean);

            return res.status(200).json({
                success: true,
                count: result.length,
                data: result,
            });

        } catch (error) {
            console.error("Get customer My Listings error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to fetch your saved services",
            });
        }
    }
);

// ============================================
// CUSTOMER: REMOVE FROM MY LISTINGS
// DELETE /api/services/my-listings/:listingId
// ============================================

router.delete(
    "/my-listings/:listingId",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const { listingId } = req.params;

            if (!isValidServiceId(listingId)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid saved service ID",
                });
            }

            const database = getDB();

            const result = await database
                .collection("customerSavedServices")
                .deleteOne({
                    _id: new ObjectId(listingId),
                    customerEmail: req.user.email,
                });

            if (result.deletedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Saved service not found",
                });
            }

            return res.status(200).json({
                success: true,
                message: "Service removed from My Listings successfully",
            });

        } catch (error) {
            console.error("Remove saved service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to remove service",
            });
        }
    }
);

// ============================================
// GET FEATURED SERVICES
// GET /api/services/featured
// PUBLIC
// ONLY APPROVED SERVICES
// ============================================

router.get("/featured", async (req, res) => {
    try {
        const database = getDB();

        const services = await database
            .collection("services")
            .find({
                approvalStatus: "approved",
                isAvailable: true,
                isDeleted: { $ne: true },
            })
            .sort({
                createdAt: -1,
            })
            .limit(6)
            .toArray();

        return res.status(200).json({
            success: true,
            count: services.length,
            data: services,
        });

    } catch (error) {
        console.error("Featured services error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch featured services",
        });
    }
});

// ============================================
// TECHNICIAN: GET MY SERVICES
// GET /api/services/my-services
// RETURNS ALL OWN SERVICES AND THEIR STATUSES
// ============================================

router.get(
    "/my-services",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const database = getDB();

            const services = await database
                .collection("services")
                .find({
                    technicianEmail: req.user.email,
                    isDeleted: { $ne: true },
                })
                .sort({
                    createdAt: -1,
                })
                .toArray();

            return res.status(200).json({
                success: true,
                total: services.length,
                data: services,
            });

        } catch (error) {
            console.error("Fetch my services error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to fetch your services",
            });
        }
    }
);

// ============================================
// EDIT A SERVICE
// PATCH /api/services/:id
// TECHNICIAN ONLY
// EDITING REQUIRES NEW ADMIN APPROVAL
// ============================================

router.patch(
    "/:id",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidServiceId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const validation = validateServiceData(req.body);

            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: validation.message,
                });
            }

            const database = getDB();

            const filter = {
                _id: new ObjectId(id),
                technicianEmail: req.user.email,
                isDeleted: { $ne: true },
            };

            const existingService = await database
                .collection("services")
                .findOne(filter);

            if (!existingService) {
                return res.status(404).json({
                    success: false,
                    message: "Service not found or you do not own this service",
                });
            }

            await database.collection("services").updateOne(
                filter,
                {
                    $set: {
                        ...validation.data,

                        // Edited services must be reviewed again
                        approvalStatus: "pending",
                        rejectionReason: "",

                        updatedAt: new Date(),
                    },
                }
            );

            const updatedService = await database
                .collection("services")
                .findOne(filter);

            return res.status(200).json({
                success: true,
                message: "Service updated and submitted for admin approval",
                data: updatedService,
            });

        } catch (error) {
            console.error("Edit service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to update service",
            });
        }
    }
);

// ============================================
// TOGGLE SERVICE AVAILABILITY
// PATCH /api/services/:id/availability
// TECHNICIAN ONLY
// ============================================

router.patch(
    "/:id/availability",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidServiceId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const database = getDB();

            const filter = {
                _id: new ObjectId(id),
                technicianEmail: req.user.email,
                isDeleted: { $ne: true },
            };

            const service = await database
                .collection("services")
                .findOne(filter);

            if (!service) {
                return res.status(404).json({
                    success: false,
                    message: "Service not found or you do not own this service",
                });
            }

            const newAvailability = !service.isAvailable;

            await database.collection("services").updateOne(
                filter,
                {
                    $set: {
                        isAvailable: newAvailability,
                        updatedAt: new Date(),
                    },
                }
            );

            return res.status(200).json({
                success: true,
                message: `Service is now ${newAvailability ? "available" : "unavailable"}`,
                isAvailable: newAvailability,
            });

        } catch (error) {
            console.error("Availability update error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to update service availability",
            });
        }
    }
);

// ============================================
// HIDE A SERVICE
// DELETE /api/services/:id
// TECHNICIAN ONLY
// ============================================

router.delete(
    "/:id",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidServiceId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const database = getDB();

            const result = await database
                .collection("services")
                .updateOne(
                    {
                        _id: new ObjectId(id),
                        technicianEmail: req.user.email,
                        isDeleted: { $ne: true },
                    },
                    {
                        $set: {
                            isDeleted: true,
                            isAvailable: false,
                            updatedAt: new Date(),
                        },
                    }
                );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Service not found or you do not own this service",
                });
            }

            return res.status(200).json({
                success: true,
                message: "Service hidden successfully",
            });

        } catch (error) {
            console.error("Hide service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to hide service",
            });
        }
    }
);

// ============================================
// GET ALL AVAILABLE SERVICES
// GET /api/services
// PUBLIC
// ONLY APPROVED SERVICES
// ============================================

router.get("/", async (req, res) => {
    try {
        const database = getDB();

        const services = await database
            .collection("services")
            .find({
                approvalStatus: "approved",
                isAvailable: true,
                isDeleted: { $ne: true },
            })
            .sort({
                createdAt: -1,
            })
            .toArray();

        return res.status(200).json({
            success: true,
            count: services.length,
            data: services,
        });

    } catch (error) {
        console.error("Get services error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch services",
        });
    }
});

// ============================================
// GET ONE SERVICE BY ID
// GET /api/services/:id
// PUBLIC
// ONLY APPROVED SERVICES
// ============================================

router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidServiceId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid service ID",
            });
        }

        const database = getDB();

        const service = await database
            .collection("services")
            .findOne({
                _id: new ObjectId(id),
                approvalStatus: "approved",
                isAvailable: true,
                isDeleted: { $ne: true },
            });

        if (!service) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        return res.status(200).json({
            success: true,
            data: service,
        });

    } catch (error) {
        console.error("Get service by ID error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch service",
        });
    }
});

export default router;
