export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  return { id: Date.now(), ...body };
});
