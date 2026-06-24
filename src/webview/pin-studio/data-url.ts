export function dataURLWithMediaType(value: string, mediaType: string): string {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    return comma >= 0 ? `data:${normalizedMediaType};base64,${value.slice(comma + 1)}` : `data:${normalizedMediaType};base64,`;
  }
  return `data:${normalizedMediaType};base64,${value}`;
}
