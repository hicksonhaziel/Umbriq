require("dotenv").config();
const { buildServer } = require("./server");

async function start() {
  const app = await buildServer();
  const port = Number(process.env.PORT || 4000);
  const host = process.env.HOST || "0.0.0.0";

  try {
    await app.listen({ port, host });
    app.log.info(`API listening on http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
