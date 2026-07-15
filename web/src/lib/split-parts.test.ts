import { describe, expect, it } from "vitest"

import {
  assignedPageSet,
  defaultPartFilenames,
  formatPageRange,
  hasDuplicateFilenames,
  isContiguousFrom,
  nextFrontier,
  normalizePdfFilename,
  partsFromEveryN,
  selectionToSortedPages,
} from "./split-parts"

describe("partsFromEveryN", () => {
  it("chunks evenly and leaves a shorter last part", () => {
    expect(partsFromEveryN(10, 4)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
  })

  it("returns one part when n >= pageCount", () => {
    expect(partsFromEveryN(3, 10)).toEqual([[0, 1, 2]])
  })
})

describe("filenames", () => {
  it("builds monotonic defaults from the stem", () => {
    expect(defaultPartFilenames("syllabus.pdf", 3)).toEqual([
      "syllabus-1.pdf",
      "syllabus-2.pdf",
      "syllabus-3.pdf",
    ])
  })

  it("normalizes to .pdf and strips path junk", () => {
    expect(normalizePdfFilename("  Chapter 1  ")).toBe("Chapter 1.pdf")
    expect(normalizePdfFilename("a.pdf")).toBe("a.pdf")
  })

  it("detects duplicate names case-insensitively", () => {
    expect(hasDuplicateFilenames(["a.pdf", "A.PDF"])).toBe(true)
    expect(hasDuplicateFilenames(["a.pdf", "b.pdf"])).toBe(false)
  })
})

describe("consecutive helpers", () => {
  it("tracks frontier and contiguous ranges", () => {
    expect(nextFrontier([])).toBe(0)
    expect(nextFrontier([[0, 1], [2]])).toBe(3)
    expect(isContiguousFrom([2, 3, 4], 2)).toBe(true)
    expect(isContiguousFrom([2, 4], 2)).toBe(false)
    expect(isContiguousFrom([3, 4], 2)).toBe(false)
  })

  it("formats 1-based ranges", () => {
    expect(formatPageRange([0])).toBe("Page 1")
    expect(formatPageRange([0, 1, 2])).toBe("Pages 1–3")
  })

  it("sorts selection", () => {
    expect(selectionToSortedPages(new Set([3, 1, 2]))).toEqual([1, 2, 3])
  })

  it("collects assigned pages", () => {
    expect([...assignedPageSet([[0], [2, 3]])].sort()).toEqual([0, 2, 3])
  })
})
