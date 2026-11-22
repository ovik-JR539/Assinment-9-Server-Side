
import { MongoClient } from "mongodb";

let client;
let database;

export async function connectDB() {

    try {

        const uri = process.env.MONGODB_URI;
        const dbName = process.env.DB_NAME;

        if (!uri) {
            throw new Error("MongoDB URI is missing");
        }

        if (!dbName) {
            throw new Error("Database name is missing");
        }

        client = new MongoClient(uri);

        await client.connect();

        // Check if MongoDB is responding
        await client.db("admin").command({ ping: 1 });

        console.log("MongoDB connected successfully");

        database = client.db(dbName);

        return database;

    } catch (error) {

        console.error("MongoDB connection failed:", error.message);

        throw error;

    }

}

export function getDB() {

    if (!database) {
        throw new Error("Database is not connected");
    }

    return database;

}
