
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { readFile } from "node:fs/promises";

const client = new MongoClient(process.env.MONGODB_URI);

async function seedServices() {
    try {
        await client.connect();

        console.log("MongoDB connected successfully");

        const database = client.db(process.env.DB_NAME);
        const servicesCollection = database.collection("services");

        // Read the JSON file
        const file = await readFile(
            new URL("../data/services.json", import.meta.url),
            "utf-8"
        );

        const services = JSON.parse(file);

        let inserted = 0;
        let updated = 0;
        let unchanged = 0;

        // Insert new services and update existing seeded services
        for (const service of services) {
            if (!ObjectId.isValid(service._id)) {
                throw new Error(`Invalid service ID: ${service._id}`);
            }

            const { _id, createdAt, ...serviceFields } = service;

            const serviceId = new ObjectId(_id);

            const serviceData = {
                ...serviceFields,
                approvalStatus: "",
                isAvailable: true,
            };

            const result = await servicesCollection.updateOne(
                { _id: serviceId },
                {
                    $set: serviceData,
                    $setOnInsert: {
                        createdAt: createdAt
                            ? new Date(createdAt)
                            : new Date(),
                    },
                },
                { upsert: true }
            );

            if (result.upsertedCount === 1) {
                inserted++;
            } else if (result.modifiedCount === 1) {
                updated++;
            } else {
                unchanged++;
            }
        }

        console.log("--------------------------------");
        console.log(`Total JSON services: ${services.length}`);
        console.log(`New services inserted: ${inserted}`);
        console.log(`Existing services updated: ${updated}`);
        console.log(`Unchanged services: ${unchanged}`);
        console.log("Service seeding completed!");
        console.log("--------------------------------");

    } catch (error) {
        console.error("Seeding failed:", error.message);
    } finally {
        await client.close();
    }
}

seedServices();
