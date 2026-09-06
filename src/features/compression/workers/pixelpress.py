import json
import math
import os
import pymupdf

_PP_JOBS = {}
_PP_TILE_PX = 3072
_PP_MAX_OCR_PIXELS = 24_000_000
# Recognition images are transient and never enter the output PDF. Keep
# JPEG quality high to avoid sacrificing text recognition accuracy.
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

def _pp_plan_lossless_images(document, dpi):
    """
    Inspect every image placement and return the lossless rasters worth
    rewriting, each tagged with the lowest DPI it is drawn at. `embedded` counts
    every placement in the document, which is roughly the work the native lossy
    pass will do afterwards.
    """
    images = {}
    mask_xrefs = set()
    embedded = 0
    # Inspect every placement before replacing anything: replacement is global,
    # and a shared image must retain enough pixels for its largest placement.
    for page in document:
        for image in page.get_images(full=True):
            embedded += 1
            xref, smask = image[:2]
            if smask:
                mask_xrefs.add(smask)
            # Newly inserted PNGs may be stored as uncompressed PDF samples.
            lossless = image[8] in ("", "FlateDecode", "LZWDecode", "RunLengthDecode")
            if xref <= 0 or not lossless or image[4] == 1:
                continue
            if xref not in images:
                # Explicit /Mask and stencil masks need different treatment from
                # /SMask. Preserve those images rather than discard transparency.
                if document.xref_get_key(xref, "Mask")[0] != "null":
                    continue
                if document.xref_get_key(xref, "ImageMask")[1] == "true":
                    continue
                images[xref] = {"xref": xref, "page": page.number, "smask": smask,
                                "dpi": math.inf}
            info = images[xref]
            for _, transform in page.get_image_rects(xref, transform=True):
                width = math.hypot(transform.a, transform.b)
                height = math.hypot(transform.c, transform.d)
                if width > 0 and height > 0:
                    info["dpi"] = min(info["dpi"],
                                      image[2] * 72 / width,
                                      image[3] * 72 / height)

    # A soft mask only surfaces on the page that uses it, so eligibility can
    # only be decided once every page has been walked.
    threshold = max(int(dpi) + 1, round(int(dpi) * 1.15))
    eligible = [
        info for xref, info in images.items()
        if xref not in mask_xrefs
        and math.isfinite(info["dpi"])
        and info["dpi"] >= threshold
    ]
    return {"images": eligible, "embedded": embedded}


def _pp_rewrite_lossless_image(document, info, dpi, quality):
    """Shrink and recompress one planned raster. False means it was left alone."""
    xref = info["xref"]
    effective_dpi = info["dpi"]
    pix = pymupdf.Pixmap(document, xref)
    if pix.colorspace is None:
        return False
    if info["smask"]:
        if pix.alpha:
            pix = pymupdf.Pixmap(pix, 0)
        mask = pymupdf.Pixmap(document, info["smask"])
        pix = pymupdf.Pixmap(pix, mask)
        del mask
    factor = 0
    while effective_dpi / (2 ** (factor + 1)) > dpi:
        factor += 1
    if factor:
        # Shrink color and alpha together to keep mask dimensions aligned.
        pix.shrink(factor)
    page = document.load_page(info["page"])
    if pix.alpha:
        page.replace_image(xref, pixmap=pix)
    else:
        if pix.colorspace.n not in (1, 3):
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        page.replace_image(xref, stream=pix.tobytes("jpeg", jpg_quality=int(quality)))
    del pix
    return True


def _pp_rewrite_lossless_images(document, dpi, quality):
    """Rewrite lossless rasters once, using their lowest DPI across placements."""
    for info in _pp_plan_lossless_images(document, dpi)["images"]:
        _pp_rewrite_lossless_image(document, info, dpi, quality)


def _pp_downsample_images(document, dpi, quality):
    """
    Shrink embedded rasters towards `dpi`, then recompress them at `quality`.
    `dpi` is a floor: the pass halves while the result stays above it, so an
    image it cannot halve is still recompressed. The threshold sits just above
    the floor so images already at or below it are left alone entirely.
    """
    # PyMuPDF 1.27 / MuPDF bug 709168 can crash while rewriting shared lossless
    # images. Replace them individually, including their soft masks, then leave
    # lossless images out of the native pass. See PyMuPDF issue #4918:
    # https://github.com/pymupdf/PyMuPDF/issues/4918#issuecomment-3966417965
    # TODO: Once Pyodide ships PyMuPDF >= 1.28 (with MuPDF >= 1.28), remove
    # _pp_rewrite_lossless_images and restore the simpler lossless=True call.
    _pp_rewrite_lossless_images(document, dpi, quality)
    _pp_rewrite_lossy_images(document, dpi, quality)


def _pp_rewrite_lossy_images(document, dpi, quality):
    """PyMuPDF's own pass over already-lossy rasters. Opaque and uninterruptible."""
    document.rewrite_images(
        dpi_threshold=max(int(dpi) + 1, round(int(dpi) * 1.15)),
        dpi_target=int(dpi),
        quality=int(quality),
        lossy=True,
        lossless=False,
        bitonal=True,
    )

def _pp_copy_page_links(source_page, target_page):
    copied = 0
    skipped = 0
    for link in source_page.get_links():
        try:
            if link.get("kind") == pymupdf.LINK_NAMED:
                skipped += 1
                continue
            target_page.insert_link(link)
            copied += 1
        except Exception:
            skipped += 1
    return copied, skipped

def _pp_append_printed_page(source_page, target_document, dpi, quality):
    """Render one malformed page as JPEG tiles and restore selectable text."""
    zoom = float(dpi) / 72.0
    tiles_x = max(1, math.ceil(source_page.rect.width * zoom / _PP_TILE_PX))
    tiles_y = max(1, math.ceil(source_page.rect.height * zoom / _PP_TILE_PX))
    target_page = target_document.new_page(
        width=source_page.rect.width,
        height=source_page.rect.height,
    )
    for tile_y in range(tiles_y):
        for tile_x in range(tiles_x):
            clip = pymupdf.Rect(
                tile_x * _PP_TILE_PX / zoom,
                tile_y * _PP_TILE_PX / zoom,
                min((tile_x + 1) * _PP_TILE_PX / zoom, source_page.rect.width),
                min((tile_y + 1) * _PP_TILE_PX / zoom, source_page.rect.height),
            )
            if clip.is_empty:
                continue
            pix = source_page.get_pixmap(
                matrix=pymupdf.Matrix(zoom, zoom),
                clip=clip,
                alpha=False,
            )
            target_page.insert_image(
                clip,
                stream=pix.tobytes(output="jpeg", jpg_quality=int(quality)),
            )
    try:
        _pp_restore_text_layer(source_page, target_page)
    except Exception:
        # Printing the page is still useful when its original text objects are
        # malformed too. The visual page remains available in that case.
        pass
    return target_page

def _pp_recover_bad_patterns(document, dpi, quality):
    """
    Rewrite healthy pages independently and print only pages whose malformed
    pattern resources make MuPDF's document-wide image pass abort.
    """
    recovered = pymupdf.open()
    printed_pages = []
    copied_links = 0
    skipped_links = 0
    try:
        for page_index in range(len(document)):
            candidate = pymupdf.open()
            try:
                candidate.insert_pdf(
                    document,
                    from_page=page_index,
                    to_page=page_index,
                    links=False,
                    annots=True,
                    final=1,
                )
                try:
                    _pp_downsample_images(candidate, dpi, quality)
                except Exception as error:
                    if "Bad PatternType" not in str(error):
                        raise
                    _pp_append_printed_page(
                        document.load_page(page_index),
                        recovered,
                        dpi,
                        quality,
                    )
                    printed_pages.append(page_index + 1)
                else:
                    recovered.insert_pdf(
                        candidate,
                        links=False,
                        annots=True,
                        final=1,
                    )
            finally:
                candidate.close()

        # Links are copied after every page exists so internal destinations keep
        # their original page numbers even though pages were processed singly.
        for page_index in range(len(document)):
            copied, skipped = _pp_copy_page_links(
                document.load_page(page_index),
                recovered.load_page(page_index),
            )
            copied_links += copied
            skipped_links += skipped

        try:
            metadata = document.metadata
            if metadata:
                recovered.set_metadata(metadata)
            toc = document.get_toc()
            if toc:
                recovered.set_toc(toc)
        except Exception:
            pass
    except Exception:
        recovered.close()
        raise
    return recovered, printed_pages, copied_links, skipped_links

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
            # Supported links are copied back onto rebuilt pages, so links alone
            # should not force Auto to preserve the page's original structure.
            protected = bool(page.first_annot or page.first_widget)
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

def pp_begin_ocr(job_id, page_index, dpi):
    """Plan large recognition tiles, independent of the output image settings.

    A 256-pixel margin on either side supplies context. Word candidates from
    overlapping tiles are merged before any selectable text is written.
    """
    job = _PP_JOBS[job_id]
    page = job["source"].load_page(int(page_index))
    zoom = float(dpi) / 72.0
    width = math.ceil(page.rect.width * zoom)
    height = math.ceil(page.rect.height * zoom)
    # Keep an ordinary page whole; large pages use ~21 MP tiles at most.
    whole = width * height <= _PP_MAX_OCR_PIXELS
    core_px = 4096
    nx = 1 if whole else max(1, math.ceil(width / core_px))
    ny = 1 if whole else max(1, math.ceil(height / core_px))
    tiles = []
    for y in range(ny):
        for x in range(nx):
            core = pymupdf.Rect(
                page.rect.width * x / nx, page.rect.height * y / ny,
                page.rect.width * (x + 1) / nx, page.rect.height * (y + 1) / ny,
            )
            margin = 256 / zoom
            clip = pymupdf.Rect(core.x0 - margin, core.y0 - margin,
                                core.x1 + margin, core.y1 + margin) & page.rect
            tiles.append({"core": core, "clip": clip})
    job["ocr"] = {"page": page, "page_index": int(page_index),
                  "zoom": zoom, "tiles": tiles, "layers": []}
    return json.dumps({"tiles": len(tiles), "dpi": dpi})


def pp_render_ocr_tile(job_id, tile_index, target_path):
    state = _PP_JOBS[job_id]["ocr"]
    tile = state["tiles"][int(tile_index)]
    zoom = state["zoom"]
    pix = state["page"].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom),
                                    clip=tile["clip"], alpha=False)
    # MuPDF rounds clips to pixel boundaries; use the actual pixmap origin
    # and extent when mapping recognition coordinates back into PDF points.
    tile["render_rect"] = pymupdf.Rect(pix.x / zoom, pix.y / zoom,
                                       (pix.x + pix.width) / zoom,
                                       (pix.y + pix.height) / zoom)
    with open(target_path, "wb") as output:
        output.write(pix.tobytes(output="jpeg", jpg_quality=_PP_OCR_JPEG_QUALITY))
    return True


def pp_append_ocr_tile(job_id, tile_index, pdf_path):
    """Keep only the small text PDF while the next recognition image is read."""
    state = _PP_JOBS[job_id]["ocr"]
    with open(pdf_path, "rb") as source:
        text_pdf = pymupdf.open(stream=source.read(), filetype="pdf")
    try:
        text_page = text_pdf[0]
        if text_page.get_images():
            raise ValueError("OCR must return a text-only PDF, without a page image.")
        state["layers"].append({"pdf": text_pdf, "tile": int(tile_index)})
    except Exception:
        text_pdf.close()
        raise
    return True


def pp_finish_ocr(job_id):
    """Merge overlap candidates by geometry, then overlay whole words.

    Comparing across tiles handles inconsistent segmentation (one word versus
    two). Prefer complete, longer candidates and suppress duplicate boxes, not
    glyphs at an arbitrary seam. Fonts and invisible rendering stay intact.
    """
    job = _PP_JOBS[job_id]
    state = job.pop("ocr")
    try:
        candidates = []
        for layer_index, layer in enumerate(state["layers"]):
            tile = state["tiles"][layer["tile"]]
            rendered = tile["render_rect"]
            page = layer["pdf"][0]
            transform = page.rect.torect(rendered)
            layer["words"] = page.get_text("words")
            layer["keep"] = set()
            for index, word in enumerate(layer["words"]):
                bounds = pymupdf.Rect(word[:4]) * transform
                # Words touching an internal image edge may be truncated.
                edges = []
                source_rect = state["page"].rect
                if rendered.x0 > source_rect.x0: edges.append(bounds.x0-rendered.x0)
                if rendered.y0 > source_rect.y0: edges.append(bounds.y0-rendered.y0)
                if rendered.x1 < source_rect.x1: edges.append(rendered.x1-bounds.x1)
                if rendered.y1 < source_rect.y1: edges.append(rendered.y1-bounds.y1)
                complete = not edges or min(edges) > 2 / state["zoom"]
                candidates.append((complete, len(word[4].strip()), layer_index, index, bounds))
        # Most complete words first; stable tie-breaking retains tile reading order.
        candidates.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))
        accepted = []
        # A spatial grid keeps ordinary dense documents from quadratic scans.
        cells = {}
        def keys(rect):
            for y in range(math.floor(rect.y0/72), math.floor(rect.y1/72)+1):
                for x in range(math.floor(rect.x0/72), math.floor(rect.x1/72)+1):
                    yield (x, y)
        for _, _, layer_index, index, bounds in candidates:
            nearby = set()
            for key in keys(bounds):
                nearby.update(cells.get(key, ()))
            duplicate = False
            for other_index in nearby:
                other_layer, other = accepted[other_index]
                if other_layer == layer_index:
                    continue
                intersection = (bounds & other).get_area()
                if intersection > 0.45 * min(bounds.get_area(), other.get_area()):
                    duplicate = True
                    break
            if not duplicate:
                state["layers"][layer_index]["keep"].add(index)
                accepted_index = len(accepted)
                accepted.append((layer_index, bounds))
                for key in keys(bounds):
                    cells.setdefault(key, []).append(accepted_index)
        target = job["output"].load_page(state["page_index"])
        rotation = target.rotation
        derotation = target.derotation_matrix
        # Calculate placement with /Rotate=0 so crop-box offsets remain correct.
        target.set_rotation(0)
        try:
            for layer in state["layers"]:
                if not layer["keep"]:
                    continue
                page = layer["pdf"][0]
                for index, word in enumerate(layer["words"]):
                    if index not in layer["keep"]:
                        page.add_redact_annot(pymupdf.Rect(word[:4]), fill=False, cross_out=False)
                if len(layer["keep"]) != len(layer["words"]):
                    page.apply_redactions(images=0, graphics=0)
                rendered = state["tiles"][layer["tile"]]["render_rect"]
                target.show_pdf_page(rendered * derotation, layer["pdf"], 0,
                                     rotate=rotation, keep_proportion=False)
        finally:
            target.set_rotation(rotation)
        return len(accepted)
    finally:
        for layer in state["layers"]:
            layer["pdf"].close()


def pp_copy_rebuilt_links(job_id):
    job = _PP_JOBS[job_id]
    copied = 0
    skipped = 0
    for page_index in sorted(job["rebuilt_pages"]):
        source_page = job["source"].load_page(page_index)
        target_page = job["output"].load_page(page_index)
        page_copied, page_skipped = _pp_copy_page_links(source_page, target_page)
        copied += page_copied
        skipped += page_skipped
    warning = None
    if skipped:
        warning = f"Preserved {copied} links on rebuilt pages; {skipped} unsupported links were skipped."
    return json.dumps({"copied": copied, "skipped": skipped, "warning": warning})

def _pp_note_finalize_warning(job, message):
    job.setdefault("finalize_warnings", []).append(message)


def _pp_abandon_image_pass(job):
    """Void whatever image work is still pending, so no later stage resumes it."""
    dpi = job.get("image_dpi") or 0
    job["image_plan"] = []
    job["image_dpi"] = 0
    return dpi


def _pp_handle_finalize_error(job, error):
    """
    Shared handler for a failed image pass, whichever stage raised it.

    A "Bad PatternType" abort is recoverable: the document is rebuilt a page at
    a time, which re-optimises every image on its own. Anything else abandons
    image rewriting with a warning. Either way the pending plan is void, so the
    caller stops stepping through it and moves on to saving.
    """
    dpi = _pp_abandon_image_pass(job)
    if "Bad PatternType" not in str(error) or not dpi:
        _pp_note_finalize_warning(job, f"Image rewriting was skipped: {error}")
        return
    output = job["output"]
    try:
        recovered, pages, _, skipped_links = _pp_recover_bad_patterns(
            output,
            int(dpi),
            int(job["settings"]["jpegQuality"]),
        )
    except Exception as recovery_error:
        _pp_note_finalize_warning(
            job,
            f"Image rewriting was skipped: {error}. "
            f"Automatic print recovery also failed: {recovery_error}"
        )
        return
    output.close()
    job["output"] = recovered
    job["recovered_pages"] = [page - 1 for page in pages]
    if pages:
        page_label = "page" if len(pages) == 1 else "pages"
        _pp_note_finalize_warning(
            job,
            f"Recovered an invalid PDF pattern by printing {page_label} "
            f"{', '.join(str(page) for page in pages)}; selectable text was "
            "restored where possible."
        )
    else:
        _pp_note_finalize_warning(
            job,
            "Recovered an invalid shared PDF pattern by rebuilding and "
            "optimising its pages independently."
        )
    if skipped_links:
        _pp_note_finalize_warning(
            job,
            f"{skipped_links} unsupported links on the recovered PDF were skipped."
        )


def pp_begin_finalize(job_id, image_dpi):
    """
    Carry the source metadata across and work out how much image rewriting is
    ahead, without doing any of it. The counts let the caller show real progress
    over the images it is about to step through, and estimate the opaque stages.
    """
    job = _PP_JOBS[job_id]
    output = job["output"]
    source = job["source"]
    job["finalize_warnings"] = []
    job["recovered_pages"] = []
    job["image_plan"] = []
    job["image_dpi"] = int(image_dpi or 0)
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
    embedded = 0
    if job["image_dpi"]:
        try:
            plan = _pp_plan_lossless_images(output, job["image_dpi"])
        except Exception as error:
            _pp_handle_finalize_error(job, error)
        else:
            job["image_plan"] = plan["images"]
            embedded = plan["embedded"]
    return json.dumps({
        "images": len(job["image_plan"]),
        "embedded": embedded,
        "pages": job["pages"],
    })


def pp_optimize_image(job_id, index):
    """
    Rewrite one planned raster. `stopped` means the plan is void — either it ran
    out or a failure discarded it — and the caller should stop stepping.
    """
    job = _PP_JOBS[job_id]
    plan = job.get("image_plan") or []
    index = int(index)
    if index >= len(plan):
        return json.dumps({"stopped": True, "changed": False})
    try:
        changed = _pp_rewrite_lossless_image(
            job["output"],
            plan[index],
            job["image_dpi"],
            int(job["settings"]["jpegQuality"]),
        )
    except Exception as error:
        _pp_handle_finalize_error(job, error)
        return json.dumps({"stopped": True, "changed": False})
    return json.dumps({"stopped": False, "changed": bool(changed)})


def pp_optimize_images_natively(job_id):
    """
    PyMuPDF's own lossy pass over the remaining rasters. A single blocking call
    with no progress inside it, so the caller estimates its duration instead.
    """
    job = _PP_JOBS[job_id]
    dpi = job.get("image_dpi") or 0
    if not dpi:
        return json.dumps({"ran": False})
    try:
        _pp_rewrite_lossy_images(job["output"], int(dpi), int(job["settings"]["jpegQuality"]))
    except Exception as error:
        _pp_handle_finalize_error(job, error)
        return json.dumps({"ran": False})
    return json.dumps({"ran": True})


def pp_save_output(job_id, output_path):
    """Write and verify the PDF, reporting every warning finalisation collected."""
    job = _PP_JOBS[job_id]
    job["output"].save(
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
    warnings = job.get("finalize_warnings") or []
    return json.dumps({
        "size": os.path.getsize(output_path),
        "warning": " ".join(warnings) if warnings else None,
        "recoveredPages": job.get("recovered_pages") or [],
    })


def pp_close(job_id):
    job = _PP_JOBS.pop(job_id, None)
    if not job:
        return
    for layer in job.get("ocr", {}).get("layers", []):
        layer["pdf"].close()
    output = job.get("output")
    source = job.get("source")
    if output is not None:
        output.close()
    if source is not None and source is not output:
        source.close()
