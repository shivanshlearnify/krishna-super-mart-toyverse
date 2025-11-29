import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { authenticate } from "../shopify.server";

export const config = {
  authenticate: {
    admin: {
      allowUnauthenticated: true,   // <-- IMPORTANT
    },
  },
};


const FIREBASE_COLLECTION = "productCollection"; // or your actual collection name


function initFirebaseFromEnv() {
  if (admin.apps && admin.apps.length) return;

  const svcPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (svcPath) {
    const fullPath = path.resolve(process.cwd(), svcPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Firebase service account file not found at ${fullPath}`);
    }
    const key = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(key),
    });
  } else if (svcJson) {
    const key = JSON.parse(svcJson);
    admin.initializeApp({
      credential: admin.credential.cert(key),
    });
  } else {
    throw new Error(
      "No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON in env.",
    );
  }
}

// Basic helper to throttle between calls
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Export a GET loader so visiting this URL triggers migration.
// Protect it with MIGRATION_SECRET query param.
export async function loader({ request }) {
  try {
    // require secret
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (!secret || secret !== process.env.MIGRATION_SECRET) {
      return new Response("Unauthorized - missing or invalid secret", {
        status: 401,
      });
    }

    // Shopify admin session
    const { session } = await authenticate.admin(request);
    if (!session) {
      return new Response("No Shopify session. Install app and re-open.", {
        status: 401,
      });
    }

    // init firebase
    initFirebaseFromEnv();
    const db = admin.firestore();

    const snapshot = await db.collection(FIREBASE_COLLECTION).get();
    const docs = snapshot.docs;
    let migrated = 0;
    const BATCH_SIZE = 10; // safe small batches

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);

      // Create each product in batch sequentially (safe)
      for (const docSnap of batch) {
        const p = docSnap.data();
        const docRef = docSnap.ref;

        // skip if already migrated
        if (p.shopifyId) {
          console.log(
            `Skipping ${docSnap.id} already migrated to ${p.shopifyId}`,
          );
          continue;
        }

        // Basic transform — update to match your fields
        const productPayload = {
          product: {
            title: p.name || "Untitled Product",
            body_html: "",
            vendor: p.supplier || "Unknown",
            product_type: p.group || "",

            tags: p.subCategory ? [p.subCategory] : [],
            variants: [
              {
                price: p.rate.toString(),
                sku: p.barcode || undefined,
                inventory_management: "shopify",
                inventory_quantity:
                  typeof p.stock === "number" ? p.stock : undefined,
                compare_at_price: p.mrp ? p.mrp.toString() : undefined,
              },
            ],
            images:
              p.images && Array.isArray(p.images) && p.images.length
                ? p.images.map((url) => ({ src: url }))
                : [],
          },
        };

        try {
          // Create product in Shopify via REST
          const created = await session.rest.Product.create({
            session,
            data: productPayload,
          });

          const shopifyProduct =
            created?.body?.product || created?.product || null;
          const shopifyId = shopifyProduct?.id;

          // create metafields (if needed)
          const metafields = [
            {
              namespace: "custom",
              key: "brand",
              type: "single_line_text_field",
              value: p.brand || "",
            },
            {
              namespace: "custom",
              key: "suppdate",
              type: "single_line_text_field",
              value: p.suppdate || "",
            },
            {
              namespace: "custom",
              key: "suppinvo",
              type: "single_line_text_field",
              value: p.suppinvo || "",
            },
            {
              namespace: "custom",
              key: "value",
              type: "number_integer",
              value: p.value || 0,
            },
          ];

          for (const mf of metafields) {
            // create only if non-empty
            if (!mf.value) continue;
            await session.rest.Metafield.create({
              session,
              data: {
                metafield: {
                  owner_resource: "product",
                  owner_id: shopifyId,
                  namespace: mf.namespace,
                  key: mf.key,
                  type: mf.type,
                  value: String(mf.value),
                },
              },
            });
            // small pause
            await sleep(200);
          }

          // update firebase doc with shopify id and migratedAt
          await docRef.update({
            shopifyId,
            migratedAt: new Date().toISOString(),
          });

          migrated++;
          console.log(
            `Migrated Firebase ${docSnap.id} -> Shopify ${shopifyId}`,
          );
        } catch (err) {
          console.error(
            "Error migrating doc",
            docSnap.id,
            err?.response || err?.message || err,
          );
          // continue with next product
        }

        // small throttle between products to be safe
        await sleep(350);
      } // end of batch

      // longer pause between batches
      await sleep(1000);
    } // end loop

    return new Response(JSON.stringify({ success: true, migrated }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Migration error:", err);
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
export async function action({ request }) {
  return loader({ request });
}