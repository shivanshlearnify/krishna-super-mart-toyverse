import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  return new Response(
    session ? "SESSION OK" : "NO SESSION",
    { status: 200 }
  );
}
