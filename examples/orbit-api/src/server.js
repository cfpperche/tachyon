import express from "express";
import { missions } from "./routes/missions.js";

export const app = express();
app.use(express.json());
app.use("/missions", missions);
app.get("/health", (_req, res) => res.json({ ok: true, service: "orbit-api" }));

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT ?? 3000;
  app.listen(port, () => console.log(`orbit-api listening on :${port}`));
}
