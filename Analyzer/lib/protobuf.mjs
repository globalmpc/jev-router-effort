// Schema-less protobuf wire decoder. Antigravity stores steps as protobuf blobs without a
// published schema, so fields are addressed by numeric path (".20.7.3") and treated as
// best-effort observations: a path that stops matching yields "unknown", never a guess.

function varint(buf, i) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= buf.length) throw new Error('truncated varint');
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, i];
    shift += 7n;
    if (shift > 70n) throw new Error('varint overflow');
  }
}

function isText(buf) {
  if (!buf.length) return false;
  const s = buf.toString('utf8');
  if (s.includes('�')) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 9 || (c > 13 && c < 32)) return false;
  }
  return true;
}

/**
 * Decode `buf` into a flat list of [path, type, value] leaves. Length-delimited fields are
 * decoded as nested messages when that succeeds, unless they are clean UTF-8 text.
 * Returns null when `buf` is not a well-formed message.
 */
export function decode(buf, path = '', depth = 0) {
  const out = [];
  let i = 0;
  try {
    while (i < buf.length) {
      let tag;
      [tag, i] = varint(buf, i);
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field === 0) return null;
      const p = `${path}.${field}`;
      if (wire === 0) {
        let v;
        [v, i] = varint(buf, i);
        out.push([p, 'int', v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()]);
      } else if (wire === 1) {
        i += 8;
      } else if (wire === 5) {
        i += 4;
      } else if (wire === 2) {
        let len;
        [len, i] = varint(buf, i);
        len = Number(len);
        if (i + len > buf.length) return null;
        const sub = buf.subarray(i, i + len);
        i += len;
        // A message holding one short string field ("\n<len>text") is also valid UTF-8; a
        // leading 0x0a that parses cleanly as a message is treated as the message.
        const text = isText(sub);
        const nested = depth < 24 && sub.length && (!text || sub[0] === 0x0a) ? decode(sub, p, depth + 1) : null;
        if (nested && nested.length) out.push(...nested);
        else if (text) out.push([p, 'str', sub.toString('utf8')]);
        else out.push([p, 'bytes', sub.length]);
      } else return null;
    }
  } catch {
    return null;
  }
  return out;
}

export function decodeOrEmpty(buf) {
  if (!buf || !buf.length) return [];
  return decode(Buffer.from(buf)) ?? [];
}

export const strings = (leaves, path) => leaves.filter(([p, t]) => t === 'str' && p === path).map(l => l[2]);
export const first = (leaves, path) => leaves.find(([p]) => p === path)?.[2];
