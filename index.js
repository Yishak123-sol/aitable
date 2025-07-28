import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto"; 

dotenv.config();

const AITABLE_API_URL = process.env.AITABLE_API_URL;
const PATCH_URL = process.env.PATCH_URL;
const AITABLE_TOKEN = process.env.AITABLE_TOKEN;

function initializeFirebaseAdmin() {
    if (!getApps().length) {
        try {
            const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
            if (!serviceAccountBase64) {
                throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
            }
            const serviceAccountJson = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
            initializeApp({
                credential: cert(serviceAccountJson)
            });
            console.log("Firebase Admin SDK initialized successfully.");
        } catch (error) {
            console.error("Failed to initialize Firebase Admin SDK:", error);
            throw error; n
        }
    }
}

function generateRandomPassword() {
    return crypto.randomBytes(16).toString('hex'); 
}

export default async function handler(req, res) {
    try {
        initializeFirebaseAdmin();
    } catch (error) {
        return res.status(500).json({ error: "Server initialization error: " + error.message });
    }
    const db = getFirestore();
    try {
        const getResponse = await fetch(AITABLE_API_URL, {
            headers: { Authorization: `Bearer ${AITABLE_TOKEN}` }
        });

        if (!getResponse.ok) {
            const errorText = await getResponse.text();
            throw new Error(`Failed to fetch AITable records: ${getResponse.status} - ${errorText}`);
        }

        const getData = await getResponse.json();
        const records = getData?.data?.records ?? [];

        if (records.length === 0) {
            return res.status(200).json({ message: "No records found in AITable." });
        }

        let syncedCount = 0;
        let skippedCount = 0;
        let errorsDuringSync = [];

        for (const record of records) {
            const { email, firstname, lastname, displayname, uid } = record.fields ?? {};

            // Skip if UID already exists in AITable record (meaning it's already synced)
            if (uid && uid !== "") {
                // console.log(`ℹ️ Skipping record ${record.recordId}: Already synced with UID ${uid}`);
                skippedCount++;
                continue;
            }

            if (!email || !firstname || !lastname || !displayname) {
                console.log(`⚠️ Skipping incomplete record ${record.recordId}: Missing email, firstname, lastname, or displayname.`);
                skippedCount++;
                continue;
            }
            try {
                let userRecord;
                try {
                    // 1. Try to get user by email first to check if they already exist
                    userRecord = await getAuth().getUserByEmail(email);
                    println(`ℹ️ Firebase user already exists for email: ${email}. UID: ${userRecord.uid}`);
                    console.log(`ℹ️ Firebase user already exists for email: ${email}. UID: ${userRecord.uid}`);
                } catch (error) {
                    if (error.code === 'auth/user-not-found') {
                        // 2. User does not exist, create a new one with a random password
                        // IMPORTANT: For real users, you'd want to send a password reset email
                        // or have them set their own password during sign-up.
                        userRecord = await getAuth().createUser({
                            email,
                            password: generateRandomPassword(), // Generate a random password
                            displayName: displayname,
                            emailVerified: true // Optionally mark as verified if data source is trusted
                        });
                        console.log(`✅ Created Firebase user: ${userRecord.uid} for ${email}`);
                    } else if (error.code === 'auth/invalid-email') {
                        console.error(`❌ Error creating Firebase user for record ${record.recordId} (${email}): Invalid email format.`);
                        errorsDuringSync.push(`Record ${record.recordId} (${email}): Invalid email format.`);
                        skippedCount++;
                        continue; // Skip this record and continue with others
                    } else {
                        // Re-throw other unexpected Firebase errors
                        throw error;
                    }
                }

                // Add or update user data in Firestore
                await db.collection("user").doc(userRecord.uid).set({
                    display_name: displayname,
                    email,
                    first_name: firstname,
                    last_name: lastname,
                    uid: userRecord.uid,
                    // Add any other relevant fields from AITable
                }, { merge: true }); // Use merge: true to avoid overwriting existing fields if document exists
                console.log(`✅ Synced Firestore data for user: ${userRecord.uid}`);

                // Patch AITable record with the new Firebase UID
                const updatedFields = { ...record.fields, uid: userRecord.uid };
                const patchResponse = await fetch(PATCH_URL, {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${AITABLE_TOKEN}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        records: [{ recordId: record.recordId, fields: updatedFields }],
                        fieldKey: "name" // Ensure this fieldKey is correct for your AITable setup
                    })
                });

                if (!patchResponse.ok) {
                    const patchError = await patchResponse.text();
                    throw new Error(`AITable PATCH error for recordId: ${record.recordId} - ${patchError}`);
                }
                console.log(`✅ Patched AITable for recordId: ${record.recordId} with UID: ${userRecord.uid}`);
                syncedCount++;

            } catch (innerError) {
                console.error(`❌ Error processing record ${record.recordId} (${email}):`, innerError.message);
                errorsDuringSync.push(`Record ${record.recordId} (${email}): ${innerError.message}`);
                skippedCount++; // Increment skipped count for records that failed during processing
            }
        }

        if (errorsDuringSync.length > 0) {
            return res.status(200).json({
                message: `✅ Sync complete. Created/Updated ${syncedCount} users. Skipped ${skippedCount} records.`,
                details: `Errors encountered for ${errorsDuringSync.length} records:`,
                errors: errorsDuringSync
            });
        } else {
            return res.status(200).json({
                message: `✅ Sync complete. Created/Updated ${syncedCount} users. Skipped ${skippedCount} incomplete/already synced records.`
            });
        }

    } catch (error) {
        console.error("❌ Fatal error in sync-users handler:", error);
        return res.status(500).json({ error: error.message });
    }
}

