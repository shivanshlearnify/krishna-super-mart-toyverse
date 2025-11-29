export async function loader({ request }) {
  const { session } = await authenticate.admin(request);

  if (!session) {
    return new Response("NO SESSION", { status: 200 });
  }

  return new Response("SESSION OK", { status: 200 });
}
