import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { shopifyApi, ApiVersion } from "../shopify.server";

export const config = {
  authenticate: { admin: { allowUnauthenticated: true } },
};

// ----------------------------
// CONFIG
// ----------------------------
const FIREBASE_COLLECTION = "productCollection"; // update if needed
const SHOP = "krishna-super-mart-toyverse-devstore.myshopify.com";

// ----------------------------
// INIT SHOPIFY ADMIN CLIENT
// ----------------------------
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_TOKEN, // IMPORTANT!
  hostName: SHOP,
  apiVersion: ApiVersion.January25,
});

const rest = shopify.rest;

// ----------------------------
// FIREBASE INITIALIZATION
// ----------------------------
function initFirebaseFromEnv() {
  if (admin.apps.length) return;

  const svcPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (svcPath) {
    const fullPath = path.resolve(process.cwd(), svcPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Firebase service account file not found at ${fullPath}`);
    }
    const key = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    admin.initializeApp({ credential: admin.credential.cert(key) });
  } else if (svcJson) {
    const key = JSON.parse(svcJson);
    admin.initializeApp({ credential: admin.credential.cert(key) });
  } else {
    throw new Error(
      "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON",
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------
// MAIN LOADER (GET API CALL)
// ----------------------------
export async function loader({ request }) {
  try {
    const url = new URL(request.url);

    // 🔐 Check migration secret
    const secret = url.searchParams.get("secret");
    if (!secret || secret !== process.env.MIGRATION_SECRET) {
      return new Response("Unauthorized - invalid secret", { status: 401 });
    }

    // 🔥 Init Firebase
    initFirebaseFromEnv();
    const db = admin.firestore();

    // Fetch all documents
    const snapshot = await db.collection(FIREBASE_COLLECTION).get();
    const docs = snapshot.docs;

    let migrated = 0;
    const BATCH_SIZE = 10;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);

      for (const docSnap of batch) {
        const p = docSnap.data();
        const docRef = docSnap.ref;

        // Already migrated?
        if (p.shopifyId) {
          console.log(`Skipping ${docSnap.id} already migrated`);
          continue;
        }

        // PRODUCT PAYLOAD
        const productPayload = {
          product: {
            title: p.name || "Untitled Product",
            body_html: "",
            vendor: p.supplier || "Unknown",
            product_type: p.group || "",
            tags: p.subCategory ? [p.subCategory] : [],
            variants: [
              {
                price: p.rate?.toString(),
                sku: p.barcode || undefined,
                inventory_management: "shopify",
                inventory_quantity: Number.isFinite(p.stock)
                  ? p.stock
                  : undefined,
                compare_at_price: p.mrp?.toString(),
              },
            ],
            images:
              Array.isArray(p.images) && p.images.length
                ? p.images.map((url) => ({ src: url }))
                : [],
          },
        };

        try {
          // -----------------------------
          // CREATE PRODUCT IN SHOPIFY
          // -----------------------------
          const created = await rest.Product.create({
            shop: SHOP,
            data: productPayload,
          });

          const shopifyId = created?.product?.id;
          console.log(`✔ Created ${shopifyId}`);

          // -----------------------------
          // CREATE METAFIELDS
          // -----------------------------
          const metafields = [
            { key: "brand", type: "single_line_text_field", value: p.brand },
            {
              key: "suppdate",
              type: "single_line_text_field",
              value: p.suppdate,
            },
            {
              key: "suppinvo",
              type: "single_line_text_field",
              value: p.suppinvo,
            },
            { key: "value", type: "number_integer", value: p.value },
          ];

          for (const mf of metafields) {
            if (!mf.value) continue;

            await rest.Metafield.create({
              shop: SHOP,
              data: {
                metafield: {
                  owner_resource: "product",
                  owner_id: shopifyId,
                  namespace: "custom",
                  key: mf.key,
                  type: mf.type,
                  value: String(mf.value),
                },
              },
            });

            await sleep(200);
          }

          // -----------------------------
          // UPDATE FIREBASE
          // -----------------------------
          await docRef.update({
            shopifyId,
            migratedAt: new Date().toISOString(),
          });

          migrated++;
          console.log(`Migrated Firebase ${docSnap.id} → Shopify ${shopifyId}`);
        } catch (err) {
          console.error("Migration error:", err);
        }

        await sleep(350);
      }

      await sleep(1000);
    }

    return new Response(JSON.stringify({ success: true, migrated }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Migration error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function action({ request }) {
  return loader({ request });
}
