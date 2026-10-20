/** Strip Docker's 8-byte multiplexing headers from a non-TTY log stream. */
export function demuxLogs(buf: Buffer): string {
  const first = buf[0];
  if (buf.length >= 8 && first !== undefined && first <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const chunks: string[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      i += 8;
      chunks.push(buf.subarray(i, i + size).toString("utf8"));
      i += size;
    }
    return chunks.join("");
  }
  return buf.toString("utf8");
}
