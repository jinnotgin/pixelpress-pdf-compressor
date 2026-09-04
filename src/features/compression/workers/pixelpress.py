import json
import math
import os
import pymupdf

_PP_JOBS = {}
_PP_TILE_PX = 3072
_PP_MAX_OCR_PIXELS = 24_000_000
# The recognition render is transient input to Tesseract and is re-encoded
# before it reaches the output, so it is kept close to lossless: compression
# artefacts cost accuracy here and buy nothing.
_PP_OCR_JPEG_QUALITY = 92

def pp_open(job_id, input_path, settings_json):
    settings = json.loads(settings_json)
    source = pymupdf.open(input_path)
    output = pymupdf.open()
    try:
        sigflags = source.get_sigflags()
    except Exception:
        sigflags = -1
    try:
        markinfo = source.markinfo or {}
        tagged = bool(markinfo.get("Marked"))
    except Exception:
        tagged = False
    try:
        has_forms = bool(source.is_form_pdf)
    except Exception:
        has_forms = False
    try:
        has_annotations = bool(source.has_annots())
    except Exception:
        has_annotations = False
    try:
        has_links = bool(source.has_links())
    except Exception:
        has_links = False
    preserve_structure = has_forms or has_annotations
    _PP_JOBS[job_id] = {
        "source": source,
        "output": output,
        "settings": settings,
        "pages": len(source),
        "preserve_structure": preserve_structure,
        "rebuilt_pages": set(),
    }
    return json.dumps({
        "pages": len(source),
        "forceOriginal": sigflags == 3,
        "preserveStructure": preserve_structure,
        "hasForms": has_forms,
        "hasAnnotations": has_annotations,
        "hasLinks": has_links,
        "tagged": tagged,
    })

def _pp_encoded_pixmap(page, dpi, quality, max_pixels=None):
    zoom = float(dpi) / 72.0
    width = max(1, math.ceil(page.rect.width * zoom))
    height = max(1, math.ceil(page.rect.height * zoom))
    if max_pixels and width * height > max_pixels:
        factor = math.sqrt(max_pixels / float(width * height))
        zoom *= factor
        width = max(1, math.ceil(page.rect.width * zoom))
        height = max(1, math.ceil(page.rect.height * zoom))
    matrix = pymupdf.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    data = pix.tobytes(output="jpeg", jpg_quality=int(quality))
    return data, width, height, zoom * 72.0

def _pp_downsample_images(document, dpi, quality):
    """
    Shrink embedded rasters towards `dpi`, then recompress them at `quality`.
    `dpi` is a floor: the pass halves while the result stays above it, so an
    image it cannot halve is still recompressed. The threshold sits just above
    the floor so images already at or below it are left alone entirely.
    """
    document.rewrite_images(
        dpi_threshold=max(int(dpi) + 1, round(int(dpi) * 1.15)),
        dpi_target=int(dpi),
        quality=int(quality),
        lossy=True,
        lossless=True,
        bitonal=True,
    )

def pp_analyze_page(job_id, page_index, include_complexity):
    job = _PP_JOBS[job_id]
    page = job["source"].load_page(int(page_index))
    text = page.get_text("text", sort=True) or ""
    meaningful = sum(1 for character in text if character.isalnum())
    replacement = text.count("�")
    words = [item[4] for item in page.get_text("words") if len(item) > 4 and any(character.isalnum() for character in item[4])]
    try:
        has_hidden_text = any(int(span.get("type", 0)) > 1 for span in page.get_texttrace())
    except Exception:
        has_hidden_text = False

    page_area = max(page.rect.get_area(), 1)
    image_coverage = 0.0
    try:
        for info in page.get_image_info(xrefs=False):
            image_rect = pymupdf.Rect(info.get("bbox", (0, 0, 0, 0))) & page.rect
            image_coverage = max(image_coverage, image_rect.get_area() / page_area)
    except Exception:
        pass

    content_bytes = 0
    if include_complexity:
        try:
            content_xrefs = set(page.get_contents() or [])
            for xobject in page.get_xobjects():
                if xobject and int(xobject[0]) > 0:
                    content_xrefs.add(int(xobject[0]))
            for xref in content_xrefs:
                stream = job["source"].xref_stream_raw(int(xref))
                if stream:
                    content_bytes += len(stream)
        except Exception:
            pass

    protected = bool(job.get("preserve_structure"))
    if not protected:
        try:
            protected = bool(page.first_link or page.first_annot or page.first_widget)
        except Exception:
            pass

    invalid_ratio = replacement / max(meaningful, 1)
    usable = meaningful >= 1 and invalid_ratio <= 0.12
    if usable and image_coverage >= 0.55 and not has_hidden_text and (meaningful < 40 or len(words) < 6):
        usable = False

    return json.dumps({
        "usable": usable,
        "characters": meaningful,
        "words": len(words),
        "hidden": has_hidden_text,
        "imageCoverage": round(image_coverage, 3),
        "contentBytes": content_bytes,
        "protected": protected,
    })

def pp_copy_original_page(job_id, page_index, final_copy):
    job = _PP_JOBS[job_id]
    index = int(page_index)
    job["output"].insert_pdf(
        job["source"],
        from_page=index,
        to_page=index,
        links=True,
        annots=True,
        final=1 if final_copy else 0,
    )
    return True

def _pp_restore_text_layer(source_page, target_page):
    restored = 0
    writer = pymupdf.TextWriter(target_page.rect)
    font = pymupdf.Font("helv")
    for word in source_page.get_text("words", sort=False):
        if len(word) < 5:
            continue
        text = str(word[4]).replace("\x00", "").strip()
        if not text:
            continue
        rect = pymupdf.Rect(word[:4])
        if rect.is_empty or rect.height <= 0:
            continue
        fontsize = max(1.0, rect.height * 0.72)
        baseline = pymupdf.Point(rect.x0, rect.y1 - max(0.5, rect.height * 0.18))
        try:
            writer.append(
                baseline,
                text,
                fontsize=fontsize,
                font=font,
            )
            restored += 1
        except Exception:
            safe_text = text.encode("latin-1", "replace").decode("latin-1")
            writer.append(
                baseline,
                safe_text,
                fontsize=fontsize,
                font=font,
            )
            restored += 1
    if restored:
        writer.write_text(target_page, render_mode=3, overlay=True)
    return restored

def pp_begin_flatten_page(job_id, page_index):
    job = _PP_JOBS[job_id]
    page = job["source"].load_page(int(page_index))
    settings = job["settings"]
    zoom = int(settings["flattenDpi"]) / 72.0
    tiles_x = max(1, math.ceil(page.rect.width * zoom / _PP_TILE_PX))
    tiles_y = max(1, math.ceil(page.rect.height * zoom / _PP_TILE_PX))
    job["flatten"] = {
        "page_index": int(page_index),
        "page": page,
        "target": job["output"].new_page(width=page.rect.width, height=page.rect.height),
        "zoom": zoom,
        "quality": int(settings["jpegQuality"]),
        "tiles_x": tiles_x,
        "tiles_y": tiles_y,
    }
    return json.dumps({"tiles": tiles_x * tiles_y})

def pp_flatten_tile(job_id, tile_index):
    state = _PP_JOBS[job_id]["flatten"]
    zoom = state["zoom"]
    page = state["page"]
    index = int(tile_index)
    tile_x = index % state["tiles_x"]
    tile_y = index // state["tiles_x"]
    clip = pymupdf.Rect(
        tile_x * _PP_TILE_PX / zoom,
        tile_y * _PP_TILE_PX / zoom,
        min((tile_x + 1) * _PP_TILE_PX / zoom, page.rect.width),
        min((tile_y + 1) * _PP_TILE_PX / zoom, page.rect.height),
    )
    if clip.is_empty:
        return False
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
    state["target"].insert_image(clip, stream=pix.tobytes(output="jpeg", jpg_quality=state["quality"]))
    return True

def pp_finish_flatten_page(job_id, restore_text):
    job = _PP_JOBS[job_id]
    state = job.pop("flatten")
    if restore_text:
        _pp_restore_text_layer(state["page"], state["target"])
    job["rebuilt_pages"].add(state["page_index"])
    return True

def pp_render_ocr_page(job_id, page_index, target_path, dpi):
    """
    Render a page for text recognition. The resolution is passed in rather than
    read from the job settings: recognition accuracy is not the user's
    size-versus-quality dial, and this image is discarded once the recognised
    page has been downsampled back to the page raster resolution.
    """
    job = _PP_JOBS[job_id]
    page = job["source"].load_page(int(page_index))
    data, width, height, effective_dpi = _pp_encoded_pixmap(
        page,
        int(dpi),
        _PP_OCR_JPEG_QUALITY,
        _PP_MAX_OCR_PIXELS,
    )
    with open(target_path, "wb") as output:
        output.write(data)
    return json.dumps({"width": width, "height": height, "effectiveDpi": effective_dpi})

def pp_append_ocr_pdf(job_id, pdf_path, page_index):
    """
    Tesseract returns the page as its invisible text layer drawn over the image
    it was given, which is deliberately rendered far above the output
    resolution. Swapping that image for a fresh render at the page raster
    resolution is what keeps recognition accuracy from dictating file size,
    while leaving the text layer — and the fonts Tesseract embedded for it —
    untouched.

    The replacement is rendered from the source page rather than resampled from
    Tesseract's copy, so it costs no extra encoding generation, and it lands on
    the exact resolution asked for: `rewrite_images` can only halve, so it would
    leave the page at twice the target. It is still the fallback for the case
    where the recognised page is not shaped the way we expect.
    """
    job = _PP_JOBS[job_id]
    settings = job["settings"]
    dpi = int(settings["flattenDpi"])
    quality = int(settings["jpegQuality"])
    warning = None
    with pymupdf.open(pdf_path) as page_pdf:
        try:
            target = page_pdf.load_page(0)
            images = target.get_images(full=True)
            if images:
                data, _, _, _ = _pp_encoded_pixmap(
                    job["source"].load_page(int(page_index)),
                    dpi,
                    quality,
                    _PP_MAX_OCR_PIXELS,
                )
                target.replace_image(images[0][0], stream=data)
        except Exception as error:
            try:
                _pp_downsample_images(page_pdf, dpi, quality)
                warning = None
            except Exception:
                warning = (
                    f"A recognised page kept its full recognition resolution: {error}"
                )
        job["output"].insert_pdf(page_pdf)
    job["rebuilt_pages"].add(int(page_index))
    return json.dumps({"warning": warning})

def pp_copy_rebuilt_links(job_id):
    job = _PP_JOBS[job_id]
    copied = 0
    skipped = 0
    for page_index in sorted(job["rebuilt_pages"]):
        source_page = job["source"].load_page(page_index)
        target_page = job["output"].load_page(page_index)
        for link in source_page.get_links():
            try:
                if link.get("kind") == pymupdf.LINK_NAMED:
                    skipped += 1
                    continue
                target_page.insert_link(link)
                copied += 1
            except Exception:
                skipped += 1
    warning = None
    if skipped:
        warning = f"Preserved {copied} links on rebuilt pages; {skipped} unsupported links were skipped."
    return json.dumps({"copied": copied, "skipped": skipped, "warning": warning})

def pp_finalize(job_id, output_path, image_dpi):
    job = _PP_JOBS[job_id]
    output = job["output"]
    source = job["source"]
    warnings = []
    if output is not source:
        try:
            metadata = source.metadata
            if metadata:
                output.set_metadata(metadata)
            toc = source.get_toc()
            if toc:
                output.set_toc(toc)
        except Exception:
            pass
    if image_dpi:
        try:
            _pp_downsample_images(output, int(image_dpi), int(job["settings"]["jpegQuality"]))
        except Exception as error:
            warnings.append(f"Image rewriting was skipped: {error}")
    output.save(
        output_path,
        garbage=4,
        deflate=True,
        deflate_images=True,
        deflate_fonts=True,
        use_objstms=True,
        compression_effort=60,
        clean=False,
    )
    with pymupdf.open(output_path) as verification:
        if len(verification) != job["pages"]:
            raise RuntimeError("The output page count did not match the source PDF.")
    warning = " ".join(warnings) if warnings else None
    return json.dumps({"size": os.path.getsize(output_path), "warning": warning})

def pp_close(job_id):
    job = _PP_JOBS.pop(job_id, None)
    if not job:
        return
    output = job.get("output")
    source = job.get("source")
    if output is not None:
        output.close()
    if source is not None and source is not output:
        source.close()
