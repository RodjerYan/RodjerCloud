/**
 * Parses a date from a filename and returns Unix timestamp in seconds (local midnight).
 * Returns null if no valid date is found.
 */
export function parseDateFromName(fileName: string): number | null {
  if (!fileName) return null

  // Pattern 1: YYYY-MM-DD, YYYY.MM.DD, YYYY_MM_DD (with optional time part)
  // Matches: 2026-02-20, 2026.02.20, 2026_02_20, 2026-02-20 14-50-04, Screenshot_2026-02-20-14-50-04.png
  // Boundary: non-alphanumeric or start/end
  const pattern1 = /(?:^|[^a-zA-Z0-9])(\d{4})[-._](\d{2})[-._](\d{2})(?:[^a-zA-Z0-9]|$)/
  const match1 = fileName.match(pattern1)
  if (match1) {
    const year = parseInt(match1[1], 10)
    const month = parseInt(match1[2], 10)
    const day = parseInt(match1[3], 10)
    const result = validateAndCreateDate(year, month, day)
    if (result !== null) return result
  }

  // Pattern 2: YYYYMMDD as separate token (boundaries: non-alphanumeric or start/end)
  // Matches: IMG_20260220_145004.jpg, VID-20260220-WA0001.mp4, 20260220
  // Does NOT match: v20260220 (letter before), 123456789 (too long)
  const pattern2 = /(?:^|[^a-zA-Z0-9])(\d{4})(\d{2})(\d{2})(?:[^a-zA-Z0-9]|$)/
  const match2 = fileName.match(pattern2)
  if (match2) {
    const year = parseInt(match2[1], 10)
    const month = parseInt(match2[2], 10)
    const day = parseInt(match2[3], 10)
    const result = validateAndCreateDate(year, month, day)
    if (result !== null) return result
  }

  // Pattern 3: DD-MM-YYYY, DD.MM.YYYY, DD_MM_YYYY (European format, day first)
  // Only accept if first component > 12 (unambiguously day) and second <= 12 (valid month)
  // Matches: 20.02.2026, 20-02-2026, 20_02_2026
  const pattern3 = /(?:^|[^a-zA-Z0-9])(\d{2})[-._](\d{2})[-._](\d{4})(?:[^a-zA-Z0-9]|$)/
  const match3 = fileName.match(pattern3)
  if (match3) {
    const day = parseInt(match3[1], 10)
    const month = parseInt(match3[2], 10)
    const year = parseInt(match3[3], 10)
    // European format: day first, only if day > 12 (unambiguous) and month <= 12
    if (day > 12 && month >= 1 && month <= 12) {
      const result = validateAndCreateDate(year, month, day)
      if (result !== null) return result
    }
  }

  return null
}

/**
 * Validates date components and returns Unix timestamp in seconds (local midnight).
 * Returns null if invalid.
 */
function validateAndCreateDate(year: number, month: number, day: number): number | null {
  // Year range: 1970..2100
  if (year < 1970 || year > 2100) return null
  // Month range: 1..12
  if (month < 1 || month > 12) return null
  // Day range: 1..31 (will be validated by Date constructor)
  if (day < 1 || day > 31) return null

  // Create date at local midnight and validate
  const date = new Date(year, month - 1, day)
  // Check if date components match (catches invalid days like 30.02.2026)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }

  // Return Unix timestamp in seconds (local midnight)
  return Math.floor(date.getTime() / 1000)
}