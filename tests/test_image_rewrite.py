"""Regression tests for the PyMuPDF 1.27 image-rewriting workaround."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import pymupdf

spec = importlib.util.spec_from_file_location(
    "pixelpress", Path(__file__).parents[1] / "src/features/compression/workers/pixelpress.py")
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)


class ImageRewriteTests(unittest.TestCase):
    def make_document(self, alpha=False, sizes=(144, 288)):
        doc = pymupdf.open()
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 600, 600), alpha)
        pix.clear_with(100)
        if alpha:
            pix.set_alpha(bytes([128]) * (600 * 600))
        xref = 0
        for size in sizes:
            page = doc.new_page(width=320, height=320)
            page.draw_rect(page.rect, fill=(0.1, 0.3, 0.8))
            rect = pymupdf.Rect(10, 10, 10 + size, 10 + size)
            if xref:
                page.insert_image(rect, xref=xref)
            else:
                xref = page.insert_image(rect, stream=pix.tobytes("png"))
        return doc, xref

    def test_shared_image_replaced_once_at_lowest_placement_dpi(self):
        doc, xref = self.make_document()
        with doc:
            original = pymupdf.Page.replace_image
            with patch.object(pymupdf.Page, "replace_image", autospec=True,
                              side_effect=original) as replace:
                pp._pp_rewrite_lossless_images(doc, 72, 80)
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

    def test_low_dpi_and_explicit_masks_are_untouched(self):
        for explicit_mask in (False, True):
            with self.subTest(explicit_mask=explicit_mask):
                doc, xref = self.make_document(sizes=(288,))
                with doc:
                    if explicit_mask:
                        doc.xref_set_key(xref, "Mask", "[0 0 0 0 0 0]")
                    original = doc.xref_stream_raw(xref)
                    pp._pp_rewrite_lossless_images(doc, 72 if explicit_mask else 150, 80)
                    self.assertEqual(doc.xref_stream_raw(xref), original)

    def test_native_pass_excludes_lossless_images(self):
        doc, _ = self.make_document()
        with doc, patch.object(pymupdf.Document, "rewrite_images") as rewrite:
            pp._pp_downsample_images(doc, 72, 80)
            self.assertFalse(rewrite.call_args.kwargs["lossless"])
            self.assertTrue(rewrite.call_args.kwargs["lossy"])


if __name__ == "__main__":
    unittest.main()
