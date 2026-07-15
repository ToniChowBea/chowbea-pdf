/** Build equal-sized page groups; the last group may be shorter. */
export function partsFromEveryN(pageCount: number, n: number): number[][] {
  if (pageCount < 1 || n < 1) return []
  const parts: number[][] = []
  for (let start = 0; start < pageCount; start += n) {
    const pages: number[] = []
    for (let i = start; i < Math.min(start + n, pageCount); i++) pages.push(i)
    parts.push(pages)
  }
  return parts
}

/** Default download names: stem-1.pdf, stem-2.pdf, … */
export function defaultPartFilenames(originalName: string, partCount: number): string[] {
  const stem = originalName.replace(/\.pdf$/i, "") || "document"
  return Array.from({ length: partCount }, (_, i) => `${stem}-${i + 1}.pdf`)
}

/** Trim and ensure a .pdf suffix. */
export function normalizePdfFilename(name: string): string {
  const trimmed = name.trim() || "document"
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`
}

/** True when any two names collide ignoring case. */
export function hasDuplicateFilenames(names: string[]): boolean {
  const seen = new Set<string>()
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/** 1-based range label for a sorted 0-based page list. */
export function formatPageRange(pages: number[]): string {
  if (pages.length === 0) return ""
  const start = pages[0]! + 1
  const end = pages[pages.length - 1]! + 1
  if (start === end) return `Page ${start}`
  return `Pages ${start}–${end}`
}

export function assignedPageSet(parts: number[][]): Set<number> {
  const set = new Set<number>()
  for (const part of parts) for (const page of part) set.add(page)
  return set
}

/** Next page index that consecutive mode must start at. */
export function nextFrontier(parts: number[][]): number {
  if (parts.length === 0) return 0
  const last = parts[parts.length - 1]!
  return last[last.length - 1]! + 1
}

/** True when `pages` is a contiguous run starting at `start`. */
export function isContiguousFrom(pages: number[], start: number): boolean {
  if (pages.length === 0 || pages[0] !== start) return false
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] !== pages[i - 1]! + 1) return false
  }
  return true
}

export function selectionToSortedPages(selected: Set<number>): number[] {
  return [...selected].sort((a, b) => a - b)
}
