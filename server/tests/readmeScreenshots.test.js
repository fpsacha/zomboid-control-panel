import { describe, expect, it } from "vitest";
import fs from "node:fs";
import zlib from "node:zlib";

// The README's dashboard screenshot came from a real panel and showed the
// host's public IP, its LAN address and the panel URL. Those fields are
// painted over with the card's background; this keeps them blank if the
// image is ever re-taken from a real server instead of demo mode.

// Decodes an 8-bit, non-interlaced RGB or RGBA PNG into rows of pixels.
function decodePng(buffer) {
  expect(buffer.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === "IDAT") {
      data.push(body);
    }
    offset += 12 + length;
  }
  expect(header).toMatchObject({ depth: 8, interlace: 0 });
  expect([2, 6]).toContain(header.colorType);
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[x] = (line[x] + add) & 0xff;
    }
    rows.push(line);
    previous = line;
  }
  const pixel = (x, y) => Array.from(rows[y].subarray(x * channels, x * channels + 3)).join(",");
  return { ...header, pixel };
}

describe("README screenshots", () => {
  it("the README shows the dashboard screenshot", () => {
    expect(fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8")).toContain("(Screenshots/screenshot-dashboard-v2.png)");
  });

  // [x, y, width, height] of each address the dashboard printed.
  it.each([
    ["public IP and game port (header)", [536, 49, 125, 11]],
    ["LAN game address (header)", [708, 49, 118, 11]],
    ["panel address (header)", [939, 49, 113, 11]],
    ["RCON address (Connections)", [427, 248, 95, 11]],
    ["panel address (Connections)", [409, 305, 113, 11]],
  ])("the dashboard screenshot shows no %s", (_label, [left, top, width, height]) => {
    const image = decodePng(fs.readFileSync(new URL("../../Screenshots/screenshot-dashboard-v2.png", import.meta.url)));
    expect([image.width, image.height]).toEqual([1531, 922]);
    const colours = new Set();
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) colours.add(image.pixel(x, y));
    }
    expect([...colours]).toHaveLength(1);
  });
});
