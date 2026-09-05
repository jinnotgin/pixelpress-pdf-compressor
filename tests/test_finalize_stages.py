"""Tests for the staged finalisation bridge that reports per-image progress."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pymupdf

spec = importlib.util.spec_from_file_location(
    "pixelpress", Path(__file__).parents[1] / "src/features/compression/workers/pixelpress.py")
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)


class FinalizeStageTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.job_id = "job"
        self.addCleanup(lambda: pp.pp_close(self.job_id))

    def make_source(self, images=2):
        """A PDF whose pages each carry one oversized lossless raster."""
        document = pymupdf.open()
        for index in range(images):
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 600, 600), False)
            pix.clear_with(40 + index * 30)
            page = document.new_page(width=320, height=320)
            page.draw_rect(page.rect, fill=(0.1, 0.3, 0.8))
            page.insert_image(pymupdf.Rect(10, 10, 154, 154), stream=pix.tobytes("png"))
        path = str(Path(self.workspace.name) / "source.pdf")
        document.save(path)
        document.close()
        return path

    def open_job(self, images=2):
        pp.pp_open(self.job_id, self.make_source(images),
                   json.dumps({"jpegQuality": 80, "flattenDpi": 150}))
        for page in range(images):
            pp.pp_copy_original_page(self.job_id, page, page == images - 1)
        return pp._PP_JOBS[self.job_id]

    def output_path(self):
        return str(Path(self.workspace.name) / "output.pdf")

    def step_through_images(self, planned):
        """Drive the loop the worker runs, returning how many steps it took."""
        steps = 0
        for index in range(planned):
            steps += 1
            if json.loads(pp.pp_optimize_image(self.job_id, index))["stopped"]:
                break
        return steps

    def test_plan_counts_images_and_each_step_rewrites_one(self):
        self.open_job()
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 72))
        self.assertEqual(plan["images"], 2)
        self.assertEqual(plan["pages"], 2)
        self.assertGreaterEqual(plan["embedded"], 2)

        original = pymupdf.Page.replace_image
        with patch.object(pymupdf.Page, "replace_image", autospec=True,
                          side_effect=original) as replace:
            for index in range(plan["images"]):
                step = json.loads(pp.pp_optimize_image(self.job_id, index))
                self.assertFalse(step["stopped"])
                self.assertEqual(replace.call_count, index + 1)

    def test_stepping_past_the_plan_stops_instead_of_raising(self):
        self.open_job()
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 72))
        self.step_through_images(plan["images"])
        self.assertTrue(json.loads(pp.pp_optimize_image(self.job_id, plan["images"]))["stopped"])

    def image_sizes(self, document):
        return [sorted((image[2], image[3]) for image in page.get_images(full=True))
                for page in document]

    def test_staged_run_matches_the_single_shot_pass(self):
        """Stepping image by image must land where the old one-shot pass did."""
        source = self.make_source()
        reference = pymupdf.open()
        with pymupdf.open(source) as original:
            reference.insert_pdf(original, final=1)
        self.addCleanup(reference.close)
        pp._pp_downsample_images(reference, 72, 80)

        pp.pp_open(self.job_id, source, json.dumps({"jpegQuality": 80, "flattenDpi": 150}))
        for page in range(2):
            pp.pp_copy_original_page(self.job_id, page, page == 1)
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 72))
        self.step_through_images(plan["images"])
        saved = json.loads(pp.pp_save_output(self.job_id, self.output_path()))

        self.assertIsNone(saved["warning"])
        self.assertEqual(saved["recoveredPages"], [])
        self.assertEqual(self.image_sizes(pp._PP_JOBS[self.job_id]["output"]),
                         self.image_sizes(reference))

    def test_bad_pattern_midway_recovers_and_voids_the_rest_of_the_plan(self):
        job = self.open_job()
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 72))
        self.assertEqual(plan["images"], 2)
        before = job["output"]

        with patch.object(pp, "_pp_rewrite_image",
                          side_effect=RuntimeError("Bad PatternType")):
            self.assertEqual(self.step_through_images(plan["images"]), 1)

        self.assertIsNot(job["output"], before)
        self.assertEqual(job["image_plan"], [])
        self.assertEqual(job["image_dpi"], 0)
        saved = json.loads(pp.pp_save_output(self.job_id, self.output_path()))
        self.assertIn("Recovered an invalid", saved["warning"])
        with pymupdf.open(self.output_path()) as output:
            self.assertEqual(len(output), 2)

    def test_other_failures_abandon_images_but_still_save(self):
        job = self.open_job()
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 72))
        with patch.object(pp, "_pp_rewrite_image",
                          side_effect=RuntimeError("something else broke")):
            self.assertEqual(self.step_through_images(plan["images"]), 1)
        self.assertEqual(job["image_plan"], [])
        saved = json.loads(pp.pp_save_output(self.job_id, self.output_path()))
        self.assertEqual(saved["warning"],
                         "Image rewriting was skipped: something else broke")
        self.assertEqual(saved["recoveredPages"], [])
        with pymupdf.open(self.output_path()) as output:
            self.assertEqual(len(output), 2)

    def test_failed_recovery_reports_both_errors(self):
        self.open_job()
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 72))
        with patch.object(pp, "_pp_rewrite_image",
                          side_effect=RuntimeError("Bad PatternType")), \
             patch.object(pp, "_pp_recover_bad_patterns",
                          side_effect=RuntimeError("recovery failed")):
            self.step_through_images(plan["images"])
        saved = json.loads(pp.pp_save_output(self.job_id, self.output_path()))
        self.assertIn("Automatic print recovery also failed", saved["warning"])

    def test_no_image_pass_still_copies_metadata_and_saves(self):
        job = self.open_job()
        job["source"].set_metadata({"title": "Carried across"})
        plan = json.loads(pp.pp_begin_finalize(self.job_id, 0))
        self.assertEqual(plan["images"], 0)
        self.assertEqual(plan["embedded"], 0)
        saved = json.loads(pp.pp_save_output(self.job_id, self.output_path()))
        self.assertIsNone(saved["warning"])
        with pymupdf.open(self.output_path()) as output:
            self.assertEqual(output.metadata["title"], "Carried across")


if __name__ == "__main__":
    unittest.main()
