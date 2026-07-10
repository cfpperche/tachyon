export type ShipFileClassification = "allowed" | "dev-artifact" | "forbidden";

export function classifyShipFile(relPath: string): ShipFileClassification;
