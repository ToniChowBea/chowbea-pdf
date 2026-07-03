/** Extensions any tool on the site can consume (Convert takes the exotic ones). */
const SUPPORTED_EXTENSIONS = [
  "pdf", "png", "jpg", "jpeg", "docx", "md", "markdown", "html", "htm", "txt",
]

/** `accept` attribute value for pickers that feed the tool handoff. */
export const SUPPORTED_ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(",")

export function isSupportedFile(file: File): boolean {
  const ext = file.name.toLowerCase().split(".").pop() ?? ""
  return SUPPORTED_EXTENSIONS.includes(ext)
}

/** True for the PDF files that five of the six tools exclusively accept. */
export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}
