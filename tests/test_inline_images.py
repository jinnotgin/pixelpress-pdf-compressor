"""Tests for rewriting images written into a content stream rather than stored
as objects.

These are byte-level splices, so most of what is worth testing is not that a
picture comes out smaller but that the scan finds exactly the right bytes: `EI`
is only a delimiter, and nothing stops those two characters occurring inside
compressed data.
"""
import importlib.util
import math
from pathlib import Path
import random
import unittest
import zlib

import pymupdf

spec = importlib.util.spec_from_file_location(
    "pixelpress", Path(__file__).parents[1] / "src/features/compression/workers/pixelpress.py")
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)

WHITESPACE = b"\x00\t\n\x0c\r "
DELIMITERS = b"()<>[]{}/%"


def photograph(width, height):
    """Something with gradients and detail, so an encoder cannot cheat at it."""
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height), 0)
    for y in range(height):
        for x in range(width):
            pix.set_pixel(x, y, (int(127 + 110 * math.sin(x / 9.0)),
                                 int(127 + 110 * math.sin((x + y) / 13.0)),
                                 int(127 + 110 * math.cos(y / 7.0))))
    return pix


def page_with_content(content, width=595, height=842):
    """A one-page document whose content stream is exactly `content`."""
    doc = pymupdf.open()
    page = doc.new_page(width=width, height=height)
    page.draw_line((0, 0), (1, 1))  # give the page a content stream to overwrite
    doc.update_stream(page.get_contents()[0], content, new=1, compress=1)
    return doc


def inline_image(pix, rect, extra=b""):
    """`pix` drawn into `rect` as raw inline samples."""
    return (b"q %d 0 0 %d %d %d cm BI /W %d /H %d /CS /RGB /BPC 8%s ID "
            % (rect[2] - rect[0], rect[3] - rect[1], rect[0], rect[1],
               pix.width, pix.height, extra)
            + pix.samples + b" EI Q\n")


def has_delimited_ei(blob):
    """Whether `blob` holds an `EI` that a scanner would accept as the end."""
    at = blob.find(b"EI")
    while at >= 0:
        after = blob[at + 2:at + 3]
        if at > 0 and blob[at - 1] in WHITESPACE and (
                not after or after in WHITESPACE or after in DELIMITERS):
            return True
        at = blob.find(b"EI", at + 2)
    return False


class InlineScanTests(unittest.TestCase):
    """Finding where one inline image ends, which is what reaching the next needs."""

    def scan_one(self, content):
        found = pp._pp_scan_inline_images(content)
        self.assertIsNotNone(found, "the stream should have been readable")
        self.assertEqual(len(found), 1)
        return found[0]

    def test_false_ei_inside_flate_data_is_stepped_over(self):
        # Deflate level 0 stores literally, so the samples appear in the stream.
        samples = (b"\x20EI\x20" * 30) + bytes(range(256)) * 2
        payload = zlib.compress(samples, 0)
        self.assertTrue(has_delimited_ei(payload))
        content = (b"BI/W %d/H 1/CS/RGB/BPC 8/F/Fl ID " % (len(samples) // 3)
                   + payload + b" EI\n")
        image = self.scan_one(content)
        self.assertEqual(content[image["data"][0]:image["data"][1]], payload)

    def test_false_ei_inside_jpeg_data_is_stepped_over(self):
        # Entropy-coded bytes are arbitrary, so a real JPEG holds a false end only
        # by luck. What tells the scan where the true one is, either way, is the
        # marker every JPEG finishes on.
        random.seed(3)
        jpeg = (b"\xff\xd8" + bytes(random.randrange(256) for _ in range(200))
                + b" EI " + bytes(random.randrange(256) for _ in range(200))
                + b"\xff\xd9")
        self.assertTrue(has_delimited_ei(jpeg))
        content = b"BI /W 8 /H 8 /CS /RGB /BPC 8 /F /DCT ID " + jpeg + b" EI\n"
        image = self.scan_one(content)
        self.assertEqual(content[image["data"][0]:image["data"][1]], jpeg)

    def test_image_mask_is_measured_rather_than_delimited(self):
        # An image is left alone but still has to be measured, or the scan cannot
        # reach whatever follows it. These samples are nothing but false ends.
        samples = b"\x20\x45\x49\x20" * 8
        content = (b"BI /W 16 /H 16 /IM true /BPC 1 ID " + samples + b" EI\n")
        image = self.scan_one(content)
        self.assertEqual(image["data"][1] - image["data"][0], len(samples))
        self.assertIsNone(image["described"], "an image mask is not rewritten")

    def test_unmeasurable_raw_samples_abandon_the_stream(self):
        # A named colour space lives in the page resources, which a byte-level
        # scan cannot resolve, so how many samples a pixel takes is unknown.
        content = b"BI /W 4 /H 4 /CS /Cs8 /BPC 8 ID " + bytes(48) + b" EI\n"
        self.assertIsNone(pp._pp_scan_inline_images(content))

    def test_explicit_length_wins_over_the_delimiter(self):
        samples = b"\x00 EI \xff" * 4
        content = (b"BI /W 4 /H 4 /CS /G /BPC 8 /L %d ID " % len(samples)
                   + samples + b" EI\n")
        image = self.scan_one(content)
        self.assertEqual(image["data"][1] - image["data"][0], len(samples))

    def test_components_per_pixel_follow_the_colour_space(self):
        for space, components in (("G", 1), ("RGB", 3), ("CMYK", 4)):
            with self.subTest(space=space):
                samples = bytes(3 * 2 * components)
                content = (b"BI /W 3 /H 2 /CS /%s /BPC 8 ID " % space.encode()
                           + samples + b" EI\n")
                image = self.scan_one(content)
                self.assertEqual(image["data"][1] - image["data"][0], len(samples))

    def test_bi_inside_a_string_or_a_name_is_not_an_operator(self):
        content = (b"BT (BI /W 9 /H 9 ID xx EI) Tj ET /BIfoo Do\n"
                   b"BI /W 2 /H 2 /CS /G /BPC 8 ID " + bytes(4) + b" EI\n")
        self.assertEqual(len(pp._pp_scan_inline_images(content)), 1)


class InlineRewriteTests(unittest.TestCase):
    """Re-encoding one, and leaving everything around it alone."""

    def assertRendersTheSame(self, before, after, tolerance=4.0):
        """Both pages draw the same thing, allowing for the quality asked for."""
        first, second = before[0].get_pixmap(dpi=100), after[0].get_pixmap(dpi=100)
        self.assertEqual((first.width, first.height), (second.width, second.height))
        samples, other = first.samples, second.samples
        step = max(1, len(samples) // 200000)
        difference = [samples[i] - other[i] for i in range(0, len(samples), step)]
        rms = math.sqrt(sum(value * value for value in difference) / len(difference))
        self.assertLess(rms, tolerance, "the page no longer draws what it drew")

    def test_raw_samples_become_a_jpeg_and_the_page_is_unchanged(self):
        pix = photograph(200, 150)
        with page_with_content(inline_image(pix, (40, 400, 440, 700))) as doc:
            before = pymupdf.open(stream=doc.tobytes(), filetype="pdf")
            plan = pp._pp_plan_images(doc, 120)
            self.assertEqual(plan["inline"], 1)
            self.assertEqual(plan["unreached"], 0)
            self.assertTrue(pp._pp_rewrite_image(doc, plan["images"][0], 120, 60))
            found = pp._pp_scan_inline_images(doc.xref_stream(doc[0].get_contents()[0]))
            self.assertEqual([image["described"]["filter"] for image in found],
                             ["DCTDecode"])
            self.assertRendersTheSame(before, doc)
            before.close()

    def test_a_bitonal_one_becomes_fax(self):
        draft = pymupdf.open()
        sheet = draft.new_page(width=420, height=300)
        sheet.insert_text((30, 60), "The quick brown fox jumps over the lazy dog.")
        grey = sheet.get_pixmap(dpi=200, colorspace=pymupdf.csGRAY)
        draft.close()
        for y in range(grey.height):  # a scan that really is only black and white
            for x in range(grey.width):
                grey.set_pixel(x, y, (0 if grey.pixel(x, y)[0] < 128 else 255,))
        content = (b"q 420 0 0 300 40 400 cm BI /W %d /H %d /CS /G /BPC 8 ID "
                   % (grey.width, grey.height) + grey.samples + b" EI Q\n")
        with page_with_content(content, width=500, height=800) as doc:
            plan = pp._pp_plan_images(doc, 150)
            self.assertTrue(pp._pp_rewrite_image(doc, plan["images"][0], 150, 60))
            found = pp._pp_scan_inline_images(doc.xref_stream(doc[0].get_contents()[0]))
            self.assertEqual([image["described"]["filter"] for image in found],
                             ["CCITTFaxDecode"])

    def test_each_of_several_in_one_stream_is_rewritten(self):
        pix = photograph(200, 150)
        content = b"".join(inline_image(pix, (40, 40 + 240 * n, 340, 265 + 240 * n))
                           for n in range(3))
        with page_with_content(content) as doc:
            before = pymupdf.open(stream=doc.tobytes(), filetype="pdf")
            plan = pp._pp_plan_images(doc, 120)
            self.assertEqual([info["ordinal"] for info in plan["images"]], [0, 1, 2])
            # Rewriting one moves every byte after it, so the next is found again
            # rather than trusted to still be where the plan saw it.
            for info in plan["images"]:
                self.assertTrue(pp._pp_rewrite_image(doc, info, 120, 60))
            found = pp._pp_scan_inline_images(doc.xref_stream(doc[0].get_contents()[0]))
            self.assertEqual([image["described"]["filter"] for image in found],
                             ["DCTDecode"] * 3)
            self.assertRendersTheSame(before, doc)
            before.close()

    def test_forms_and_annotation_appearances_are_reached(self):
        pix = photograph(200, 150)
        drawing = inline_image(pix, (0, 0, 400, 300))
        with page_with_content(b"q 1 0 0 1 60 480 cm /Fm0 Do Q\n") as doc:
            page = doc[0]
            form = doc.get_new_xref()
            doc.update_object(
                form, "<</Type/XObject/Subtype/Form/BBox[0 0 400 300]/Resources<<>>>>")
            doc.update_stream(form, drawing, new=1, compress=1)
            doc.xref_set_key(page.xref, "Resources", "<</XObject<</Fm0 %d 0 R>>>>" % form)

            annot = page.add_rect_annot(pymupdf.Rect(60, 100, 460, 400))
            appearance = doc.get_new_xref()
            doc.update_object(
                appearance,
                "<</Type/XObject/Subtype/Form/BBox[0 0 400 300]/Resources<<>>>>")
            doc.update_stream(appearance, drawing, new=1, compress=1)
            doc.xref_set_key(annot.xref, "AP/N", "%d 0 R" % appearance)

            plan = pp._pp_plan_images(doc, 120)
            self.assertEqual(plan["inline"], 2, "the form and the appearance")
            self.assertEqual(sorted(info["stream"] for info in plan["images"]),
                             sorted([form, appearance]))
            for info in plan["images"]:
                self.assertTrue(pp._pp_rewrite_image(doc, info, 120, 60))

    def test_a_second_pass_leaves_everything_alone(self):
        pix = photograph(200, 150)
        with page_with_content(inline_image(pix, (40, 400, 440, 700))) as doc:
            for info in pp._pp_plan_images(doc, 120)["images"]:
                pp._pp_rewrite_image(doc, info, 120, 60)
            again = pp._pp_plan_images(doc, 120)
            self.assertFalse(
                any(pp._pp_rewrite_image(doc, info, 120, 60) for info in again["images"]),
                "a JPEG at the same quality can only come out bigger")

    def test_a_small_one_is_kept_because_a_jpeg_of_it_is_bigger(self):
        # Inline images are meant to be small, and a JPEG carries a few hundred
        # bytes of tables and markers before it encodes anything. Below a certain
        # size that overhead is the whole file, so the guard keeps the original.
        pix = photograph(8, 8)
        with page_with_content(inline_image(pix, (40, 400, 120, 480))) as doc:
            content = doc.xref_stream(doc[0].get_contents()[0])
            planned = pp._pp_plan_images(doc, 72)["images"]
            self.assertEqual(len(planned), 1, "raw samples are always worth trying")
            self.assertFalse(pp._pp_rewrite_image(doc, planned[0], 72, 60))
            self.assertEqual(doc.xref_stream(doc[0].get_contents()[0]), content,
                             "declining has to leave the stream exactly as it was")

    def test_object_and_inline_images_are_planned_together(self):
        pix = photograph(300, 225)
        doc = pymupdf.open()
        page = doc.new_page(width=595, height=842)
        page.insert_image(pymupdf.Rect(40, 40, 280, 220), pixmap=pix)
        with doc:
            content = doc.xref_stream(page.get_contents()[0])
            doc.update_stream(page.get_contents()[0],
                              content + inline_image(pix, (40, 400, 440, 700)),
                              new=1, compress=1)
            plan = pp._pp_plan_images(doc, 120)
            self.assertEqual(sorted(info["kind"] for info in plan["images"]),
                             ["inline", "xref"])
            for info in plan["images"]:
                self.assertTrue(pp._pp_rewrite_image(doc, info, 120, 60))


if __name__ == "__main__":
    unittest.main()
