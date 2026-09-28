/** Read a top-level JSON string while it is still being streamed. Never expose the JSON envelope. */
export function streamedTextField(raw: string, field: string): string {
  let depth = 0;
  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (char === "{" || char === "[") { depth += 1; index += 1; continue; }
    if (char === "}" || char === "]") { depth -= 1; index += 1; continue; }
    if (char !== '"') { index += 1; continue; }
    const token = readString(raw, index);
    if (depth === 1 && token.finished) {
      let next = token.end;
      while (/\s/.test(raw[next] || "")) next += 1;
      if (raw[next] === ":" && token.value === field) {
        next += 1;
        while (/\s/.test(raw[next] || "")) next += 1;
        return raw[next] === '"' ? readString(raw, next).value : "";
      }
    }
    if (!token.finished) break;
    index = token.end;
  }
  return "";
}

function readString(raw: string, start: number): { value: string; end: number; finished: boolean } {
  let value = "";
  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') return { value, end: index + 1, finished: true };
    if (char !== "\\") { value += char; continue; }
    const escape = raw[++index];
    if (!escape) break;
    if (escape === "u") {
      const hex = raw.slice(index + 1, index + 5);
      if (!/^[\da-fA-F]{4}$/.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16));
      index += 4;
      continue;
    }
    const decoded: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (!(escape in decoded)) break;
    value += decoded[escape];
  }
  return { value, end: raw.length, finished: false };
}
