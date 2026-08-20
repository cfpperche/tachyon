import fs from "node:fs";

export function readFromOwnerA(file: string): void {
  fs.readFileSync(file, "utf8");
}
