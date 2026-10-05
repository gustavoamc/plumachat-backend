import dotenv from "dotenv";
dotenv.config();

import { createServer } from "http";
import app from "./app";
import { initIO } from "./sockets/setupSocket";
import { connectDB } from "./config/db";
import ensureRootExists from "./helpers/ensureRootExists";

// Last-resort safety net: log stray async errors instead of letting a single
// failed handler take the whole server down.
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});

// creates an HTTP server to integrate with Socket.IO
const server = createServer(app);

// initializes Socket.IO with the HTTP server
initIO(server);

const PORT = process.env.PORT || 3000;
connectDB().then(async () => {
  try {
    await ensureRootExists();
  } catch (err) {
    console.error("❌ Erro ao verificar conta root:", err);
  }
  server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
  });
});
