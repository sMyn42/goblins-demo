"""The Locust image fixture is a real drawn PNG at the app's canvas dimensions."""
from __future__ import annotations

import struct
import unittest
import zlib

from canvas_image import render_canvas_png


class CanvasImageTests(unittest.TestCase):
    def test_drawn_png_matches_app_dimensions_and_is_under_upload_limit(self) -> None:
        image = render_canvas_png()
        self.assertLess(len(image), 2 * 1024 * 1024)
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        offset = 8
        chunks = {}
        while offset < len(image):
            length = struct.unpack(">I", image[offset:offset + 4])[0]
            kind = image[offset + 4:offset + 8]
            payload = image[offset + 8:offset + 8 + length]
            crc = struct.unpack(">I", image[offset + 8 + length:offset + 12 + length])[0]
            self.assertEqual(crc, zlib.crc32(kind + payload) & 0xFFFFFFFF)
            chunks[kind] = chunks.get(kind, b"") + payload
            offset += length + 12
        width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunks[b"IHDR"])
        self.assertEqual((width, height), (1000, 500))
        self.assertEqual((bit_depth, color_type, compression, filtering, interlace), (8, 6, 0, 0, 0))
        decoded = zlib.decompress(chunks[b"IDAT"])
        self.assertEqual(len(decoded), (width * 4 + 1) * height)
        self.assertTrue(any(value < 100 for value in decoded))
        self.assertEqual(image[-8:], b"IEND\xaeB`\x82")


if __name__ == "__main__":
    unittest.main()
