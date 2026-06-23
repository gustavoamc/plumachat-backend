import express from "express";
import cors from "cors";

import AuthRoutes from "./routes/auth.routes";
import UserRoutes from "./routes/user.routes";
import AdminRoutes from "./routes/admin.routes";
import RoomRoutes from "./routes/room.routes";
import InviteRoutes from "./routes/inviteKey.routes";
import { UPLOAD_ROOT } from "./config/uploads";

const app = express();

app.use(cors());
app.use(express.json());

// Serve user-uploaded board images. Filenames are random (hard to guess); the
// per-room dir is removed when the room is deleted.
app.use("/uploads", express.static(UPLOAD_ROOT));

app.use("/", AuthRoutes);
app.use("/user", UserRoutes);
app.use("/admin", AdminRoutes);
app.use("/room", RoomRoutes);
app.use("/invite", InviteRoutes);

// Rotas de exemplo
app.get("/ping", (_, res) => res.send("pong"));

export default app;

//TODO: implement logs with logModel