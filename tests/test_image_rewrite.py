"""Shared-image rewriting and transparency regression tests."""
import importlib.util
from pathlib import Path
import unittest
import random
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

    def test_explicit_masks_are_untouched(self):
        doc, xref = self.make_document(sizes=(288,))
        with doc:
            doc.xref_set_key(xref, "Mask", "[0 0 0 0 0 0]")
            original = doc.xref_stream_raw(xref)
            pp._pp_downsample_images(doc, 72, 80)
            self.assertEqual(doc.xref_stream_raw(xref), original)

    def test_low_dpi_jpeg_recompresses_without_resizing(self):
        rng = random.Random(7)
        pix = pymupdf.Pixmap(pymupdf.csRGB, 300, 300, rng.randbytes(300 * 300 * 3), False)
        with pymupdf.open() as doc:
            page = doc.new_page(width=320, height=320)
            # Same 108 DPI as the large eligibility screenshot PDF.
            xref = page.insert_image(pymupdf.Rect(0, 0, 200, 200),
                                     stream=pix.tobytes("jpeg", jpg_quality=100))
            original_size = len(doc.xref_stream_raw(xref))
            plan = pp._pp_plan_images(doc, 120)["images"]
            self.assertEqual(len(plan), 1)
            self.assertAlmostEqual(plan[0]["dpi"], 108)
            self.assertTrue(pp._pp_rewrite_image(doc, plan[0], 120, 78))
            self.assertEqual((pymupdf.Pixmap(doc, xref).width,
                              pymupdf.Pixmap(doc, xref).height), (300, 300))
            self.assertLess(len(doc.xref_stream_raw(xref)), original_size * 0.6)

    def make_masked_jpeg(self, width=601, height=599):
        # Vary alpha from transparent through partial to opaque over bright
        # colour: catches dropped masks and accidental premultiplied JPEGs.
        color = pymupdf.Pixmap(pymupdf.csRGB, width, height,
                              bytes([220, 80, 40]) * width * height, False)
        samples = bytes(round(x * 255 / (width - 1)) for x in range(width)) * height
        mask = pymupdf.Pixmap(pymupdf.csGRAY, width, height, samples, False)
        doc = pymupdf.open()
        page = doc.new_page(width=320, height=320)
        page.draw_rect(page.rect, fill=(0.1, 0.3, 0.8))
        xref = page.insert_image(pymupdf.Rect(10, 10, 298, 298),
                                 stream=color.tobytes("jpeg"), mask=mask.tobytes("png"))
        return doc, xref

    def test_shared_jpeg_with_gradient_mask_retains_appearance(self):
        doc, xref = self.make_masked_jpeg()
        with doc:
            for _ in range(65):
                page = doc.new_page(width=320, height=320)
                page.draw_rect(page.rect, fill=(0.1, 0.3, 0.8))
                page.insert_image(pymupdf.Rect(10, 10, 298, 298), xref=xref)
            before = doc[0].get_pixmap().samples
            plan = pp._pp_plan_images(doc, 72)["images"]
            self.assertEqual(len(plan), 1)
            with patch.object(pymupdf.Document, "rewrite_images",
                              side_effect=AssertionError("unsafe native pass")):
                pp._pp_downsample_images(doc, 72, 80)
            with pymupdf.open(stream=doc.tobytes(garbage=4, deflate=True), filetype="pdf") as saved:
                for page in saved:
                    image = page.get_images()[0]
                    self.assertEqual(image[2:4], (301, 300))
                    self.assertEqual(image[8], "FlateDecode")
                    mask = pymupdf.Pixmap(saved, image[1])
                    self.assertEqual((mask.width, mask.height), image[2:4])
                    self.assertLessEqual(min(mask.samples), 1)
                    self.assertGreaterEqual(max(mask.samples), 254)
                after = saved[0].get_pixmap().samples
                self.assertLess(sum(abs(a-b) for a, b in zip(before, after)) / len(before), 1.5)
                self.assertLessEqual(max(abs(a-b) for a, b in zip(before, after)), 8)

    def test_resizing_does_not_mutate_a_mask_shared_by_an_unmodified_image(self):
        doc, xref = self.make_masked_jpeg()
        with doc:
            smask = doc[0].get_images()[0][1]
            original = doc.xref_stream(smask)
            # A distinct image uses the same mask but appears at a lower DPI.
            other = doc.get_new_xref()
            doc.update_object(other, "<<>>")
            doc.xref_copy(xref, other)
            page = doc.new_page(width=720, height=720)
            page.insert_image(page.rect, xref=other)
            plan = pp._pp_plan_images(doc, 72)["images"]
            pp._pp_rewrite_image(doc, next(info for info in plan if info["xref"] == xref), 72, 80)
            self.assertEqual(doc.xref_stream(smask), original)
            self.assertEqual(doc.xref_get_key(other, "SMask")[1], f"{smask} 0 R")
            self.assertEqual(pymupdf.Pixmap(doc, other).width, 601)
            self.assertNotEqual(doc.xref_get_key(xref, "SMask")[1], f"{smask} 0 R")

    def test_matte_and_mismatched_masks_are_preserved(self):
        for matte in (False, True):
            with self.subTest(matte=matte):
                doc, xref = self.make_masked_jpeg()
                with doc:
                    smask = doc[0].get_images()[0][1]
                    if matte:
                        doc.xref_set_key(smask, "Matte", "[1 1 1]")
                    else:
                        doc.xref_set_key(smask, "Width", "1")
                    original = doc.xref_object(xref), doc.xref_stream_raw(xref)
                    pp._pp_downsample_images(doc, 72, 80)
                    self.assertEqual((doc.xref_object(xref), doc.xref_stream_raw(xref)), original)

    def test_larger_jpeg_candidate_keeps_original_bytes(self):
        rng = random.Random(0)
        pix = pymupdf.Pixmap(pymupdf.csRGB, 64, 64, rng.randbytes(64 * 64 * 3), False)
        with pymupdf.open() as doc:
            page = doc.new_page()
            xref = page.insert_image(pymupdf.Rect(0, 0, 16, 16),
                                     stream=pix.tobytes("jpeg", jpg_quality=10))
            original = doc.xref_object(xref), doc.xref_stream_raw(xref)
            plan = pp._pp_plan_images(doc, 300)["images"]
            self.assertEqual(len(plan), 1)
            self.assertFalse(pp._pp_rewrite_image(doc, plan[0], 300, 100))
            self.assertEqual((doc.xref_object(xref), doc.xref_stream_raw(xref)), original)

    def test_identical_colour_with_different_masks_stays_distinct(self):
        doc, xref = self.make_masked_jpeg()
        with doc:
            first_mask = doc[0].get_images()[0][1]
            other = doc.get_new_xref()
            doc.update_object(other, "<<>>")
            doc.xref_copy(xref, other)
            inverse = doc.get_new_xref()
            doc.update_object(inverse, "<<>>")
            doc.xref_copy(first_mask, inverse)
            doc.xref_set_key(inverse, "Decode", "[1 0]")
            doc.xref_set_key(other, "SMask", f"{inverse} 0 R")
            page = doc.new_page(width=320, height=320)
            page.insert_image(pymupdf.Rect(10, 10, 298, 298), xref=other)
            pp._pp_downsample_images(doc, 72, 80)
            masks = [pymupdf.Pixmap(doc, int(doc.xref_get_key(x, "SMask")[1].split()[0]))
                     for x in (xref, other)]
            self.assertLess(masks[0].samples[0], 2)
            self.assertGreater(masks[1].samples[0], 253)
            self.assertEqual(doc[0].get_images()[0][0], xref)
            self.assertEqual(len(doc[0].get_images()), 1)
            self.assertEqual(len(doc[1].get_images()), 1)

    def test_eight_bit_black_white_images_are_not_jpeg_encoded(self):
        for cs in (pymupdf.csGRAY, pymupdf.csRGB):
            with self.subTest(colorspace=cs), pymupdf.open() as doc:
                samples = (bytes([0]) * cs.n + bytes([255]) * cs.n) * (64 * 32)
                pix = pymupdf.Pixmap(cs, 64, 64, samples, False)
                page = doc.new_page()
                xref = page.insert_image(pymupdf.Rect(0, 0, 16, 16), pixmap=pix)
                original = doc.xref_object(xref), doc.xref_stream_raw(xref)
                pp._pp_downsample_images(doc, 72, 20)
                self.assertEqual((doc.xref_object(xref), doc.xref_stream_raw(xref)), original)

    def test_continuous_grayscale_stays_grayscale(self):
        with pymupdf.open() as doc:
            pix = pymupdf.Pixmap(pymupdf.csGRAY, 256, 256, bytes(range(256)) * 256, False)
            page = doc.new_page()
            xref = page.insert_image(pymupdf.Rect(0, 0, 64, 64), pixmap=pix)
            pp._pp_downsample_images(doc, 72, 80)
            self.assertEqual(pymupdf.Pixmap(doc, xref).colorspace.n, 1)
            self.assertEqual(doc.xref_get_key(xref, "Filter")[1], "/DCTDecode")

    def test_native_pass_is_never_called(self):
        doc, _ = self.make_document()
        with doc, patch.object(pymupdf.Document, "rewrite_images") as rewrite:
            pp._pp_downsample_images(doc, 72, 80)
            rewrite.assert_not_called()


if __name__ == "__main__":
    unittest.main()
