import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import fetch from "node-fetch";

let initialized = false;
dotenv.config();


export default async function handler(req, res) {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    const serviceAccountJson = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));  
    if (!initialized) {
        initializeApp({
            credential: cert(serviceAccountJson)
        });
        initialized = true;
    }

    const db = getFirestore();

    const AITABLE_API_URL = process.env.AITABLE_API_URL;
    const AITABLE_TOKEN = process.env.AITABLE_TOKEN;
    const FIXED_PASSWORD = "Pass12345@";

    try {
        const getResponse = await fetch(AITABLE_API_URL, {
            headers: {
                Authorization: `Bearer ${AITABLE_TOKEN}`
            }
        });
        const getData = await getResponse.json();
        const records = getData?.data?.records ?? [];

        if (records.length === 0) {
            return res.status(200).json({ message: "No records found in AITable." });
        }
        let syncedCount = 0;
        let skippedCount = 0;
        let totalCount = records.length;

        // 2️⃣ Process each record
        for (const record of records) {
            const { email, firstname, lastname, displayname, uid } = record.fields ?? {};

            // Already synced?
            if (uid && uid !== "") {
                continue;
            }
            // ✅ Check for all required fields
            if (
                !email ||
                !firstname ||
                !lastname ||
                !displayname ||
                email.trim() === "" ||
                firstname.trim() === "" ||
                lastname.trim() === "" ||
                displayname.trim() === ""
            ) {
                console.log(`⚠️ Skipping incomplete record: ${record.recordId}`);

                skippedCount++;
                continue;
            }

            // ✅ Create Firebase Auth user
            const userRecord = await getAuth().createUser({
                email,
                password: FIXED_PASSWORD,
                displayName: displayname
            });
            console.log(`✅ Created Firebase user: ${userRecord.uid} for email: ${email}`);

            // ✅ Add user doc in Firestore (collection = user)
            await db.collection('user').doc(userRecord.uid).set({
                display_name: displayname,
                email: email,
                first_name: firstname,
                last_name: lastname,
                uid: userRecord.uid
            });
            console.log(`✅ Saved user profile in Firestore (collection: user) for UID: ${userRecord.uid}`);

            // ✅ PATCH back to AITable with new UID
           const PATCH_URL = process.env.PATCH_URL;
            const updatedFields = {
                ...record.fields,
                uid: userRecord.uid
            };

            const patchResponse = await fetch(PATCH_URL, {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${AITABLE_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    records: [
                        {
                            recordId: record.recordId,
                            fields: updatedFields
                        }
                    ],
                    fieldKey: "name"
                })
            });

            if (!patchResponse.ok) {
                const patchError = await patchResponse.text();
                console.error(`❌ Failed PATCH for ${record.recordId} - ${patchError}`);
                throw new Error(`AITable PATCH error for recordId: ${record.recordId}`);
            }

            console.log(`✅ Patched AITable for recordId: ${record.recordId}`);
            syncedCount++;
        }

        return res.status(200).json({
            message: `✅ Sync complete. Created ${syncedCount} users. Skipped ${skippedCount} incomplete records. Total records: ${totalCount}`
        });
    } catch (error) {
        console.error("❌ Error in sync-users handler:", error);
        return res.status(500).json({ error: error.message });
    }
}