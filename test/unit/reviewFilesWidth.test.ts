import { describe, expect, it } from "vitest";
import {
  REVIEW_FILES_WIDTH_DEFAULT_REM,
  REVIEW_FILES_WIDTH_MIN_REM,
  REVIEW_FILES_WIDTH_STEP_REM,
  REVIEW_FILES_WIDTH_STORAGE_KEY,
  clampFilesWidthRem,
  filesWidthMaxRem,
  parseStoredFilesWidthRem,
} from "@tachyon/webview-ui/webview/review/filesWidth.js";

describe("t-2f7e8c — review file-list width helpers", () => {
  it("keeps today's 16rem as the default and derives min as half of that", () => {
    expect(REVIEW_FILES_WIDTH_DEFAULT_REM).toBe(16);
    expect(REVIEW_FILES_WIDTH_MIN_REM).toBe(8);
    expect(REVIEW_FILES_WIDTH_STEP_REM).toBe(1);
    expect(REVIEW_FILES_WIDTH_STORAGE_KEY).toBe("tachyon.review.filesWidthRem");
  });

  it("treats missing or non-numeric storage as unset so the CSS default applies", () => {
    expect(parseStoredFilesWidthRem(null)).toBeUndefined();
    expect(parseStoredFilesWidthRem("")).toBeUndefined();
    expect(parseStoredFilesWidthRem("nope")).toBeUndefined();
    expect(parseStoredFilesWidthRem("24")).toBe(24);
  });

  it("clamps between the derived min and the measured max", () => {
    expect(clampFilesWidthRem(4, 40)).toBe(8);
    expect(clampFilesWidthRem(16, 40)).toBe(16);
    expect(clampFilesWidthRem(99, 40)).toBe(40);
  });

  it("leaves the stacked pane at least the derived min even at 360", () => {
    expect(filesWidthMaxRem(360, 16)).toBeGreaterThanOrEqual(REVIEW_FILES_WIDTH_MIN_REM);
    expect(filesWidthMaxRem(880, 16)).toBe(880 / 16 - REVIEW_FILES_WIDTH_MIN_REM);
  });
});
