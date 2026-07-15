import { unzipSync, zipSync } from "fflate"

/** Extract trailing `-{n}.pdf` part index for stable numeric ordering. */
function partIndexFromEntry(name: string): number | null {
  const match = name.match(/-(\d+)\.pdf$/i)
  return match ? Number(match[1]) : null
}

/** Order ZIP entries by part number so `stem-2` stays before `stem-10`. */
function sortZipEntryKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const indexA = partIndexFromEntry(a)
    const indexB = partIndexFromEntry(b)
    if (indexA !== null && indexB !== null) return indexA - indexB
    if (indexA !== null) return -1
    if (indexB !== null) return 1
    return a.localeCompare(b)
  })
}

/**
 * Unzip `blob`, rename entries in sorted original order to `names`, re-zip.
 * `names.length` must equal the number of files in the archive.
 */
export async function renameZipEntries(blob: Blob, names: string[]): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const entries = unzipSync(bytes)
  const keys = sortZipEntryKeys(Object.keys(entries))
  if (keys.length !== names.length) {
    throw new Error("File count does not match the rename list.")
  }
  const next: Record<string, Uint8Array> = {}
  keys.forEach((key, index) => {
    next[names[index]!] = entries[key]!
  })
  const out = zipSync(next)
  // Copy into a fresh ArrayBuffer so Blob gets a real ArrayBuffer, not ArrayBufferLike.
  const copy = new Uint8Array(out.byteLength)
  copy.set(out)
  return new Blob([copy.buffer], { type: "application/zip" })
}
