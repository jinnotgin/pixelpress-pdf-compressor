"""Tests for the pass that rewrites image objects by xref.

Replacement is per object and therefore global, so most of what is worth
testing is not that a picture comes out smaller but that the plan decides
correctly: which images it reaches, which it refuses to touch, and how small a
shared one is allowed to become.
"""
import importlib.util
import math
from pathlib import Path
import unittest
from unittest.mock import patch

import pymupdf

spec = importlib.util.spec_from_file_location(
    "pixelpress", Path(__file__).parents[1] / "src/features/compression/workers/pixelpress.py")
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)


def photograph(width, height):
    """Something with gradients and detail, so an encoder cannot cheat at it."""
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height), 0)
    for y in range(height):
        for x in range(width):
            pix.set_pixel(x, y, (int(127 + 110 * math.sin(x / 9.0)),
                                 int(127 + 110 * math.sin((x + y) / 13.0)),
                                 int(127 + 110 * math.cos(y / 7.0))))
    return pix


class ImageRewriteTests(unittest.TestCase):
    def make_document(self, alpha=False, sizes=(144, 288), stream=None):
        """One 600px raster placed at each of `sizes` points, on a page each."""
        if stream is None:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 600, 600), alpha)
            pix.clear_with(100)
            if alpha:
                pix.set_alpha(bytes([128]) * (600 * 600))
            stream = pix.tobytes("png")
        doc = pymupdf.open()
        xref = 0
        for size in sizes:
            page = doc.new_page(width=320, height=320)
            page.draw_rect(page.rect, fill=(0.1, 0.3, 0.8))
            rect = pymupdf.Rect(10, 10, 10 + size, 10 + size)
            if xref:
                page.insert_image(rect, xref=xref)
            else:
                xref = page.insert_image(rect, stream=stream)
        return doc, xref

    def test_shared_image_replaced_once_at_lowest_placement_dpi(self):
        doc, xref = self.make_document()
        with doc:
            # Both placements are of one object, so the plan carries one entry
            # tagged with the lowest DPI either of them draws it at.
            plan = pp._pp_plan_images(doc, 72)
            self.assertEqual([info["xref"] for info in plan["images"]], [xref])
            self.assertEqual(plan["images"][0]["dpi"], 150)

            with patch.object(pp, "_pp_replace_image_stream", autospec=True,
                              side_effect=pp._pp_replace_image_stream) as replace:
                pp._pp_downsample_images(doc, 72, 80)
                self.assertEqual(replace.call_count, 1)
            # Largest placement is 150 DPI: halve once to 75, not twice to 37.5.
            self.assertEqual(pymupdf.Pixmap(doc, xref).width, 300)
            for page in doc:
                self.assertIn(xref, [image[0] for image in page.get_images()])

    def test_soft_mask_survives_shrinking_and_save(self):
        doc, xref = self.make_document(alpha=True)
        with doc:
            before = [page.get_pixmap().samples for page in doc]
            pp._pp_downsample_images(doc, 72, 80)
            with pymupdf.open(stream=doc.tobytes(garbage=4, deflate=True), filetype="pdf") as saved:
                for index, page in enumerate(saved):
                    image = page.get_images()[0]
                    self.assertEqual(image[2:4], (300, 300))
                    self.assertGreater(image[1], 0)
                    mask = pymupdf.Pixmap(saved, image[1])
                    self.assertEqual((mask.width, mask.height), (300, 300))
                    after = page.get_pixmap().samples
                    self.assertEqual(len(before[index]), len(after))
                    self.assertLessEqual(max(abs(a-b) for a, b in zip(before[index], after)), 2)

    def test_an_already_lossy_image_at_the_floor_is_untouched(self):
        # A losslessly stored raster is re-encoded whatever size it is drawn at,
        # because becoming a JPEG shrinks it on its own. One that is already a
        # JPEG has to have resolution to give up before it is worth decoding, so
        # for it — and only it — the DPI floor decides.
        doc, xref = self.make_document(
            sizes=(288,), stream=photograph(600, 600).tobytes("jpeg", jpg_quality=80))
        with doc:
            self.assertEqual(pp._pp_filter_name(doc, xref), "DCTDecode")
            original = doc.xref_stream_raw(xref)
            pp._pp_downsample_images(doc, 150, 80)  # drawn at exactly 150 DPI
            self.assertEqual(doc.xref_stream_raw(xref), original)
            pp._pp_downsample_images(doc, 72, 80)
            self.assertNotEqual(doc.xref_stream_raw(xref), original)
            self.assertEqual(pymupdf.Pixmap(doc, xref).width, 300)

    def test_an_explicitly_masked_image_is_untouched(self):
        # /Mask carries transparency outside the sample data, which no format
        # written here can hold on to, so the image is never even planned.
        doc, xref = self.make_document(sizes=(288,))
        with doc:
            doc.xref_set_key(xref, "Mask", "[0 0 0 0 0 0]")
            original = doc.xref_stream_raw(xref)
            self.assertEqual(pp._pp_plan_images(doc, 72)["images"], [])
            pp._pp_downsample_images(doc, 72, 80)
            self.assertEqual(doc.xref_stream_raw(xref), original)

    def test_the_pass_never_hands_images_to_pymupdf(self):
        # `Document.rewrite_images()` is all-or-nothing, reports no progress and
        # segfaults on shared images in the PyMuPDF Pyodide ships; replacing
        # objects by xref is what this pass exists to do instead.
        doc, _ = self.make_document()
        with doc, patch.object(pymupdf.Document, "rewrite_images") as rewrite:
            pp._pp_downsample_images(doc, 72, 80)
            rewrite.assert_not_called()


if __name__ == "__main__":
    unittest.main()
