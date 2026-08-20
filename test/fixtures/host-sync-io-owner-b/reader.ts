import fs from "node:fs";

export function readFromOwnerB(file: string): void {
  fs.readFileSync(file, "utf8");
}
