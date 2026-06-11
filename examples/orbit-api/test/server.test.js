import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/server.js";

describe("orbit-api", () => {
  it("health says ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("lists missions and finds one by id", async () => {
    expect((await request(app).get("/missions")).body).toHaveLength(2);
    expect((await request(app).get("/missions/1")).body.name).toBe("Voyager");
    expect((await request(app).get("/missions/99")).status).toBe(404);
  });
});
