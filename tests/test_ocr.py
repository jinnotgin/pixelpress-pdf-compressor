"""PDF-engine regressions: python3 -m unittest discover -s tests -v.

Requires PyMuPDF >= 1.26.1. Optional real OCR test uses the tesseract CLI.
"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import pymupdf

spec = importlib.util.spec_from_file_location(
    'pixelpress', Path(__file__).parents[1] / 'src/features/compression/workers/pixelpress.py')
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)


class OcrTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        for job in list(pp._PP_JOBS):
            pp.pp_close(job)
        self.tmp.cleanup()

    def open_page(self, width=600, height=800, rotation=0, crop=False):
        path = self.root / 'source.pdf'
        with pymupdf.open() as doc:
            page = doc.new_page(width=width, height=height)
            page.draw_rect(pymupdf.Rect(50, 50, 200, 180), fill=(0.2, 0.5, 0.8))
            if crop:
                page.set_cropbox(pymupdf.Rect(20, 30, width-20, height-30))
            page.set_rotation(rotation)
            doc.save(path)
        pp.pp_open('job', str(path), json.dumps({'flattenDpi': 48, 'jpegQuality': 85}))
        pp.pp_copy_original_page('job', 0, True)
        return pp._PP_JOBS['job']

    def overlay(self, tile_index, words):
        state = pp._PP_JOBS['job']['ocr']
        tile = state['tiles'][tile_index]
        rendered = tile['render_rect']
        path = self.root / 'text.pdf'
        # Deliberately use pixel units to exercise scaling back to PDF points.
        scale = state['zoom']
        with pymupdf.open() as doc:
            page = doc.new_page(width=rendered.width * scale, height=rendered.height * scale)
            for x, y, text in words:
                page.insert_text(((x-rendered.x0)*scale, (y-rendered.y0)*scale),
                                 text, fontsize=12*scale, render_mode=3)
            doc.save(path)
        pp.pp_append_ocr_tile('job', tile_index, str(path))

    def test_whole_page_and_rotated_cropped_alignment(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                job = self.open_page(rotation=rotation, crop=True)
                before = job['output'][0].get_pixmap().samples
                plan = json.loads(pp.pp_begin_ocr('job', 0, 200))
                self.assertEqual(plan['tiles'], 1)
                pp.pp_render_ocr_tile('job', 0, str(self.root/'tile.jpg'))
                self.overlay(0, [(100, 120, 'Searchable')])
                pp.pp_finish_ocr('job')
                page = job['output'][0]
                self.assertEqual(before, page.get_pixmap().samples)
                hit = page.search_for('Searchable')
                self.assertEqual(len(hit), 1)
                displayed = hit[0] * page.rotation_matrix
                self.assertAlmostEqual(displayed.x0, 100, delta=0.1)
                self.assertAlmostEqual(displayed.y1, 123.588, delta=0.1)
                pp.pp_close('job')

    def test_overlapping_words_are_whole_and_unique(self):
        job = self.open_page(width=3300, height=1000)
        plan = json.loads(pp.pp_begin_ocr('job', 0, 200))
        self.assertEqual(plan['tiles'], 3)
        # One word crosses each seam; both neighbouring tiles see it.
        words = [(1075, 200, 'BoundaryOne'), (2175, 200, 'BoundaryTwo')]
        before = job['output'][0].get_pixmap(matrix=pymupdf.Matrix(.2,.2)).samples
        for index, tile in enumerate(job['ocr']['tiles']):
            pp.pp_render_ocr_tile('job', index, str(self.root/'tile.jpg'))
            clip = tile['render_rect']
            visible = [w for w in words if clip.x0 < w[0] and w[0]+80 < clip.x1]
            if index == 2:
                # A neighbouring recogniser can split a word differently.
                visible = [(2175, 200, 'Boundary'), (2227, 200, 'Two')]
            self.overlay(index, visible)
        pp.pp_finish_ocr('job')
        page = job['output'][0]
        for _, _, text in words:
            self.assertEqual(page.get_text().count(text), 1)
            self.assertEqual(len(page.search_for(text)), 1)
        self.assertEqual(before, page.get_pixmap(matrix=pymupdf.Matrix(.2,.2)).samples)

    def test_large_plan_stays_bounded_without_lowering_dpi(self):
        job = self.open_page(width=6000, height=12000)
        json.loads(pp.pp_begin_ocr('job', 0, 200))
        state = job['ocr']
        self.assertEqual(state['zoom'], 200/72)
        for tile in state['tiles']:
            clip = tile['clip']
            self.assertLessEqual((clip.width*state['zoom']+2)*(clip.height*state['zoom']+2),
                                 pp._PP_MAX_OCR_PIXELS)

    def test_flatten_output_obeys_requested_dpi(self):
        job = self.open_page()
        widths = []
        for dpi in (48, 150):
            job['output'].close()
            job['output'] = pymupdf.open()
            job['settings']['flattenDpi'] = dpi
            plan = json.loads(pp.pp_begin_flatten_page('job', 0))
            for tile in range(plan['tiles']):
                pp.pp_flatten_tile('job', tile)
            pp.pp_finish_flatten_page('job', False)
            pp.pp_begin_ocr('job', 0, 200)
            pp.pp_render_ocr_tile('job', 0, str(self.root/'tile.jpg'))
            self.overlay(0, [(100, 120, 'Searchable')])
            pp.pp_finish_ocr('job')
            widths.append(job['output'][0].get_images()[0][2])
        self.assertEqual(widths, [400, 1250])

    @unittest.skipUnless(shutil.which('tesseract'), 'Tesseract CLI is optional')
    def test_real_ocr_across_tile_boundaries(self):
        job = self.open_page(width=3300, height=1000)
        for x, label in [(1055, 'BoundaryOne'), (2155, 'BoundaryTwo')]:
            job['source'][0].insert_text((x, 300), label, fontsize=20)
        pix = job['source'][0].get_pixmap()
        scan = pymupdf.open()
        scan.new_page(width=3300, height=1000).insert_image(
            pymupdf.Rect(0,0,3300,1000), pixmap=pix)
        job['source'].close()
        job['source'] = scan
        job['output'].close()
        job['output'] = pymupdf.open()
        pp.pp_copy_original_page('job', 0, True)
        before = job['output'][0].get_pixmap().samples
        plan = json.loads(pp.pp_begin_ocr('job', 0, 200))
        self.assertEqual(plan['tiles'], 3)
        for index in range(plan['tiles']):
            pp.pp_render_ocr_tile('job', index, str(self.root/'tile.jpg'))
            subprocess.run(['tesseract', str(self.root/'tile.jpg'), str(self.root/'recognized'),
                            '--dpi', '200', '-c', 'textonly_pdf=1', 'pdf'],
                           check=True, capture_output=True)
            pp.pp_append_ocr_tile('job', index, str(self.root/'recognized.pdf'))
        pp.pp_finish_ocr('job')
        for label in ('BoundaryOne', 'BoundaryTwo'):
            self.assertEqual(job['output'][0].get_text().count(label), 1)
            self.assertEqual(len(job['output'][0].search_for(label)), 1)
        self.assertEqual(before, job['output'][0].get_pixmap().samples)

    @unittest.skipUnless(shutil.which('tesseract'), 'Tesseract CLI is optional')
    def test_real_tesseract_text_only_overlay(self):
        job = self.open_page()
        # Render text to an image-only source as in a scanned PDF.
        job['source'][0].insert_text((100, 250), 'Searchable example', fontsize=20)
        pix = job['source'][0].get_pixmap(matrix=pymupdf.Matrix(2,2))
        scan = pymupdf.open()
        scan.new_page(width=600, height=800).insert_image(pymupdf.Rect(0,0,600,800), pixmap=pix)
        job['source'].close()
        job['source'] = scan
        job['output'].close()
        job['output'] = pymupdf.open()
        pp.pp_copy_original_page('job', 0, True)
        before = job['output'][0].get_pixmap().samples
        pp.pp_begin_ocr('job', 0, 200)
        pp.pp_render_ocr_tile('job', 0, str(self.root/'tile.jpg'))
        subprocess.run(['tesseract', str(self.root/'tile.jpg'), str(self.root/'recognized'),
                        '--dpi', '200', '-c', 'textonly_pdf=1', 'pdf'],
                       check=True, capture_output=True)
        pp.pp_append_ocr_tile('job', 0, str(self.root/'recognized.pdf'))
        pp.pp_finish_ocr('job')
        self.assertEqual(before, job['output'][0].get_pixmap().samples)
        self.assertEqual(len(job['output'][0].search_for('Searchable example')), 1)
        self.assertEqual(len(job['output'][0].get_images()), 1)


if __name__ == '__main__':
    unittest.main()
