import json
import math
import os
import pymupdf

_PP_JOBS = {}
_PP_TILE_PX = 3072
_PP_MAX_OCR_PIXELS = 24_000_000

def pp_open(job_id, input_path, settings_json):
    settings = json.loads(settings_json)
    source = pymupdf.open(input_path)
    output = pymupdf.open()
    _PP_JOBS[job_id] = {"source": source, "output": output, "settings": settings}
    return json.dumps({"pages": len(source)})

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

def pp_analyze_page(job_id, page_index):
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

    invalid_ratio = replacement / max(meaningful, 1)
    usable = meaningful >= 3 and invalid_ratio <= 0.12
    if usable and image_coverage >= 0.55 and not has_hidden_text and (meaningful < 40 or len(words) < 6):
        usable = False

    return json.dumps({
        "usable": usable,
        "characters": meaningful,
        "words": len(words),
        "hidden": has_hidden_text,
        "imageCoverage": round(image_coverage, 3),
    })

def pp_copy_original_page(job_id, page_index, final_copy):
    job = _PP_JOBS[job_id]
    index = int(page_index)
    job["output"].insert_pdf(
        job["source"],
        from_page=index,
        to_page=index,
        links=False,
        annots=True,
        final=1 if final_copy else 0,
    )
    return True

def _pp_restore_text_layer(source_page, target_page):
    restored = 0
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
            target_page.insert_text(
                baseline,
                text,
                fontsize=fontsize,
                fontname="helv",
                render_mode=3,
                overlay=True,
            )
            restored += 1
        except Exception:
            safe_text = text.encode("latin-1", "replace").decode("latin-1")
            target_page.insert_text(
                baseline,
                safe_text,
                fontsize=fontsize,
                fontname="helv",
                render_mode=3,
                overlay=True,
            )
            restored += 1
    return restored

def pp_begin_flatten_page(job_id, page_index):
    job = _PP_JOBS[job_id]
    page = job["source"].load_page(int(page_index))
    settings = job["settings"]
    zoom = int(settings["dpi"]) / 72.0
    tiles_x = max(1, math.ceil(page.rect.width * zoom / _PP_TILE_PX))
    tiles_y = max(1, math.ceil(page.rect.height * zoom / _PP_TILE_PX))
    job["flatten"] = {
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
    state = _PP_JOBS[job_id].pop("flatten")
    if restore_text:
        _pp_restore_text_layer(state["page"], state["target"])
    return True

def pp_render_ocr_page(job_id, page_index, target_path):
    job = _PP_JOBS[job_id]
    page = job["source"].load_page(int(page_index))
    settings = job["settings"]
    data, width, height, effective_dpi = _pp_encoded_pixmap(
        page,
        int(settings["dpi"]),
        int(settings["jpegQuality"]),
        _PP_MAX_OCR_PIXELS,
    )
    with open(target_path, "wb") as output:
        output.write(data)
    return json.dumps({"width": width, "height": height, "effectiveDpi": round(effective_dpi)})

def pp_append_ocr_pdf(job_id, pdf_path):
    job = _PP_JOBS[job_id]
    with pymupdf.open(pdf_path) as page_pdf:
        job["output"].insert_pdf(page_pdf)
    return True

def pp_finalize(job_id, output_path):
    job = _PP_JOBS[job_id]
    output = job["output"]
    source = job["source"]
    settings = job["settings"]
    warning = None
    try:
        metadata = source.metadata
        if metadata:
            output.set_metadata(metadata)
        toc = source.get_toc()
        if toc:
            output.set_toc(toc)
    except Exception:
        pass
    try:
        dpi = int(settings["dpi"])
        if settings.get("strategy") != "flatten":
            output.rewrite_images(
                dpi_threshold=max(dpi + 1, round(dpi * 1.15)),
                dpi_target=dpi,
                quality=int(settings["jpegQuality"]),
                lossy=True,
                lossless=True,
                bitonal=True,
            )
    except Exception as error:
        warning = f"Image rewriting was skipped: {error}"
    output.save(output_path, garbage=4, deflate=True, deflate_images=True, clean=True)
    with pymupdf.open(output_path) as verification:
        if len(verification) != len(source):
            raise RuntimeError("The output page count did not match the source PDF.")
    return json.dumps({"size": os.path.getsize(output_path), "warning": warning})

def pp_close(job_id):
    job = _PP_JOBS.pop(job_id, None)
    if not job:
        return
    if job.get("output") is not None:
        job["output"].close()
    job["source"].close()
