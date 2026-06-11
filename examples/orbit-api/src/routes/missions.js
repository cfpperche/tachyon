import { Router } from "express";

export const missions = Router();

const db = [
  { id: 1, name: "Voyager", status: "active" },
  { id: 2, name: "Cassini", status: "complete" },
];

missions.get("/", (_req, res) => res.json(db));
missions.get("/:id", (req, res) => {
  const mission = db.find((m) => m.id === Number(req.params.id));
  if (!mission) return res.status(404).json({ error: "mission not found" });
  res.json(mission);
});
