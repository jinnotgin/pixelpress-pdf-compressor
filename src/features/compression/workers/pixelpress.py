import json
import math
import os
import re
import zlib
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

# Embedded images are rewritten here rather than by `Document.rewrite_images()`.
# That call rewrites page content streams to reach every image, which makes it
# all-or-nothing: one malformed pattern aborts the whole document, it reports no
# progress and cannot be interrupted, and in the PyMuPDF that Pyodide ships it
# looks a placement's DPI up by position in a list built during an earlier
# traversal, which segfaults when the two traversals disagree about shared
# images (PyMuPDF issue #4918, fixed upstream in 1.28). Replacing image objects
# by xref instead never touches a content stream, so it sidesteps all of that
# and reports real progress. What it costs is reach: an object pass sees only
# what the page's resources name, so annotation appearances and inline images —
# the two things a content-stream pass gets for free — are each walked
# separately below.


def _pp_colorspace_family(document, xref):
    """The colour model an image declares: `DeviceRGB`, `Indexed`, `DeviceN`..."""
    kind, text = document.xref_get_key(xref, "ColorSpace")
    if kind == "xref":
        text = document.xref_object(int(text.split()[0]))
    text = text.strip().lstrip("[").strip()
    return text[1:].split()[0].split("/")[0] if text.startswith("/") else ""


def _pp_filter_name(document, xref):
    """
    The codec an image's bytes are in. A filter array decodes left to right, so
    the last entry is the image format and the earlier ones only wrap it.
    """
    kind, text = document.xref_get_key(xref, "Filter")
    names = re.findall(r"/([A-Za-z0-9]+)", text) if kind in ("name", "array") else []
    return names[-1] if names else ""


def _pp_int_key(document, xref, key):
    try:
        return int(document.xref_get_key(xref, key)[1])
    except (TypeError, ValueError):
        return 0


def _pp_describe_image(document, xref):
    """
    What one image object is, or None when it has to be left alone.

    The exclusions mirror MuPDF's own rewriter: stencil masks and explicitly
    masked images carry their transparency outside the sample data, and
    Separation / DeviceN samples only mean anything in their own colour model,
    so re-encoding any of them into a device space would lose information. A
    JPEG 2000 image may also carry its alpha inside the codestream, which no
    format written here can hold on to, so leave those whole as well.
    """
    if document.xref_get_key(xref, "ImageMask")[1] == "true":
        return None
    if document.xref_get_key(xref, "Mask")[0] != "null":
        return None
    if _pp_int_key(document, xref, "SMaskInData") > 0:
        return None
    if _pp_colorspace_family(document, xref) in ("Separation", "DeviceN"):
        return None
    width = _pp_int_key(document, xref, "Width")
    height = _pp_int_key(document, xref, "Height")
    if width <= 0 or height <= 0:
        return None
    smask = document.xref_get_key(xref, "SMask")
    return {
        "kind": "xref",
        "xref": xref,
        "width": width,
        "height": height,
        "smask": int(smask[1].split()[0]) if smask[0] == "xref" else 0,
        "filter": _pp_filter_name(document, xref),
        "dpi": math.inf,
    }


def _pp_xobject_references(document, xref):
    """
    Every XObject named by one stream's resources.

    The /XObject dictionary may be written inline or held in an object of its
    own, and both spellings are common, so read whichever is there as source
    text and pull the indirect references out of it.
    """
    kind, text = document.xref_get_key(xref, "Resources/XObject")
    if kind == "xref":
        text = document.xref_object(int(text.split()[0]))
    elif kind != "dict":
        return []
    return [int(number) for number in re.findall(r"/[^\s/\[\]<>()]+\s+(\d+)\s+\d+\s+R", text)]


def _pp_appearance_images(document, roots, seen):
    """Image xrefs drawn by an appearance stream, following nested forms."""
    images = []
    pending = list(roots)
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        for target in _pp_xobject_references(document, current):
            if document.xref_is_image(target):
                images.append(target)
            else:
                pending.append(target)
    return images


def _pp_annotation_appearances(document, page):
    """
    (appearance stream xrefs, rect) for every annotation drawn on `page`.

    Only the normal appearance is displayed, so the down and rollover streams
    are left alone. /N is a stream for most annotations and a dictionary of
    named states for the ones that have several, such as checkboxes.
    """
    appearances = []
    seen_annots = set()
    for annot in list(page.annots()) + list(page.widgets()):
        if annot.xref in seen_annots:
            continue
        seen_annots.add(annot.xref)
        kind, text = document.xref_get_key(annot.xref, "AP/N")
        if kind == "xref":
            roots = [int(text.split()[0])]
        elif kind == "dict":
            roots = [int(number) for number in re.findall(r"(\d+)\s+\d+\s+R", text)]
        else:
            continue
        if roots:
            appearances.append((roots, annot.rect))
    return appearances


# An inline image is written into the middle of a content stream as
# `BI <dict> ID <bytes> EI`, so it has no object of its own to replace and is the
# one thing the xref pass above cannot reach. It is handled here by splicing
# bytes: the stream is scanned, one image's region is swapped for a re-encoded
# one, and every byte around it is copied through untouched. Nothing else is
# re-lexed or re-emitted, so a stream this cannot follow exactly is left alone
# rather than rewritten into something subtly different.

_PP_WHITESPACE = b"\x00\t\n\x0c\r "
_PP_DELIMITERS = b"()<>[]{}/%"

# Every inline dictionary key, filter and colour space has an abbreviation, and
# both spellings are legal and both occur. Read either; write the short one,
# which is what MuPDF itself writes.
_PP_INLINE_KEYS = {
    "BPC": "BitsPerComponent", "CS": "ColorSpace", "D": "Decode",
    "DP": "DecodeParms", "F": "Filter", "H": "Height", "IM": "ImageMask",
    "I": "Interpolate", "L": "Length", "W": "Width",
}
_PP_INLINE_FILTERS = {
    "AHx": "ASCIIHexDecode", "A85": "ASCII85Decode", "LZW": "LZWDecode",
    "Fl": "FlateDecode", "RL": "RunLengthDecode", "CCF": "CCITTFaxDecode",
    "DCT": "DCTDecode",
}
_PP_INLINE_SPACES = {"G": "DeviceGray", "RGB": "DeviceRGB", "CMYK": "DeviceCMYK"}
_PP_SPACE_COMPONENTS = {"DeviceGray": 1, "DeviceRGB": 3, "DeviceCMYK": 4}
_PP_SHORT_FILTERS = {"DCTDecode": "DCT", "CCITTFaxDecode": "CCF", "FlateDecode": "Fl"}
_PP_SHORT_SPACES = {"DeviceGray": "G", "DeviceRGB": "RGB", "DeviceCMYK": "CMYK"}
# What each encoding guarantees its last bytes look like. Anything absent here
# ends wherever the stream says it does, with nothing to check that against.
_PP_INLINE_TERMINATORS = {
    "ASCIIHexDecode": b">",
    "ASCII85Decode": b"~>",
    "DCTDecode": b"\xff\xd9",
    "RunLengthDecode": b"\x80",
}


def _pp_skip_literal_string(data, index):
    """Index just past the literal string opening at `index`, escapes and all."""
    depth = 0
    size = len(data)
    while index < size:
        byte = data[index]
        if byte == 0x5C:
            index += 2
            continue
        if byte == 0x28:
            depth += 1
        elif byte == 0x29:
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return size


def _pp_next_token(data, index):
    """
    (start, end, text) for the next token at or after `index`, or None at the end.

    Strings, names and comments come back whole so that a search for an operator
    can never read one out of the middle of somebody's text.
    """
    size = len(data)
    while index < size:
        if data[index] in _PP_WHITESPACE:
            index += 1
        elif data[index] == 0x25:
            while index < size and data[index] not in b"\r\n":
                index += 1
        else:
            break
    if index >= size:
        return None
    start = index
    byte = data[index]
    if byte == 0x28:
        return start, _pp_skip_literal_string(data, index), b"("
    if byte == 0x3C:
        if data[index + 1:index + 2] == b"<":
            return start, index + 2, b"<<"
        end = data.find(b">", index)
        return start, size if end < 0 else end + 1, b"<"
    if byte == 0x3E:
        return start, index + (2 if data[index + 1:index + 2] == b">" else 1), b">>"
    if byte in b"[]{}":
        return start, index + 1, data[start:index + 1]
    index += 1
    if byte != 0x2F:
        index = start
    while index < size and data[index] not in _PP_WHITESPACE and data[index] not in _PP_DELIMITERS:
        index += 1
    if index == start:
        index += 1
    return start, index, data[start:index]


def _pp_read_object(data, index):
    """(source text, index past it) for one value, following nested arrays and dicts."""
    token = _pp_next_token(data, index)
    if token is None:
        return None, index
    start, end, text = token
    if text not in (b"[", b"<<"):
        return data[start:end], end
    depth = 1
    while depth:
        token = _pp_next_token(data, end)
        if token is None:
            return None, end
        _, end, text = token
        if text in (b"[", b"<<"):
            depth += 1
        elif text in (b"]", b">>"):
            depth -= 1
    return data[start:end], end


def _pp_parse_inline_dict(data, index):
    """
    ({full key: source text}, index past `ID`) for the dictionary opening an
    inline image, or (None, index) when it is not shaped the way this can splice.
    """
    fields = {}
    while True:
        token = _pp_next_token(data, index)
        if token is None:
            return None, index
        _, index, text = token
        if text == b"ID":
            return fields, index
        if not text.startswith(b"/"):
            return None, index
        key = text[1:].decode("latin-1", "replace")
        value, index = _pp_read_object(data, index)
        if value is None:
            return None, index
        fields[_PP_INLINE_KEYS.get(key, key)] = value.decode("latin-1", "replace")


def _pp_inline_filters(fields):
    """The filter chain in full spelling, outermost — the one the bytes are in — first."""
    names = re.findall(r"/([A-Za-z0-9]+)", fields.get("Filter", ""))
    return [_PP_INLINE_FILTERS.get(name, name) for name in names]


def _pp_inline_space(fields):
    """
    The colour space as an object-level name, or None when it cannot be used.

    A name that is not a device space refers to the page's resources, which a
    byte-level splice has no way to resolve, and Separation / DeviceN samples
    only mean anything in their own model. Both are left alone here, as they are
    on the object path.
    """
    text = (fields.get("ColorSpace") or "/DeviceGray").strip()
    if not text.startswith("/"):
        return None
    name = text[1:]
    return _PP_INLINE_SPACES.get(name) or (name if name in _PP_SPACE_COMPONENTS else None)


def _pp_inline_geometry(fields):
    """
    (width, height, bits per component, components per pixel), or None when the
    dictionary does not say all four.

    This has to be answerable even for an image that will be left alone, because
    it is what says how much room unfiltered samples take — and finding the end
    of one image is the only way to reach the next.
    """
    if fields.get("ImageMask", "").strip() == "true":
        components = 1
    else:
        space = _pp_inline_space(fields)
        components = _PP_SPACE_COMPONENTS[space] if space else None
    try:
        width = int(fields["Width"])
        height = int(fields["Height"])
        bpc = int(fields.get("BitsPerComponent", "8"))
    except (KeyError, ValueError):
        return None
    if components is None or width <= 0 or height <= 0 or bpc <= 0:
        return None
    return width, height, bpc, components


def _pp_describe_inline(fields):
    """
    What one inline image is, or None when it has to be left alone. The
    exclusions mirror `_pp_describe_image`'s, minus the ones an inline image
    cannot express.
    """
    space = _pp_inline_space(fields)
    geometry = _pp_inline_geometry(fields)
    if space is None or geometry is None:
        return None
    if fields.get("ImageMask", "").strip() == "true":
        return None
    filters = _pp_inline_filters(fields)
    return {
        "width": geometry[0], "height": geometry[1], "bpc": geometry[2],
        "space": space, "filters": filters, "filter": filters[-1] if filters else "",
    }


def _pp_inline_data_complete(candidate, filters):
    """
    Whether `candidate` is a whole encoding rather than a prefix of one.

    `EI` is only a delimiter — nothing stops those two bytes occurring inside
    binary data — so a candidate end is believed only once whatever terminator
    the outermost filter guarantees has been found at it. Flate says so exactly;
    LZW and CCITT guarantee nothing, and there the delimiter is all there is.
    """
    if not filters:
        return True
    outer = filters[0]
    if outer == "FlateDecode":
        try:
            stream = zlib.decompressobj()
            stream.decompress(bytes(candidate))
            stream.flush()
        except zlib.error:
            return False
        return stream.eof and not stream.unused_data
    terminator = _PP_INLINE_TERMINATORS.get(outer)
    if terminator is None:
        return True
    return candidate.rstrip(_PP_WHITESPACE).endswith(terminator)


def _pp_inline_extent(data, start, fields):
    """
    (data end, index past `EI`) for one inline image, or None when neither can be
    known confidently.

    Unfiltered samples occupy one byte-aligned row per row of pixels, and an
    explicit /L is exact as well, so both give the answer outright. Encoded data
    has to be found by its delimiter instead, one candidate at a time.
    """
    size = len(data)
    filters = _pp_inline_filters(fields)
    geometry = _pp_inline_geometry(fields)

    def closing(end):
        """Index past the `EI` that must follow the data ending at `end`."""
        token = _pp_next_token(data, end)
        if token is None or token[2] != b"EI":
            return None
        return token[1]

    exact = None
    if not filters and geometry:
        width, height, bpc, components = geometry
        exact = ((width * bpc * components + 7) // 8) * height
    try:
        exact = int(fields["Length"])
    except (KeyError, ValueError):
        pass
    if exact is not None:
        end = start + exact
        after = closing(end) if end <= size else None
        return (end, after) if after else None

    if not filters:
        # Raw samples are where a stray `EI` is likeliest to turn up and, with no
        # encoding to end cleanly, a delimiter would be the only thing to go on.
        # Give up on the stream rather than cut one open at a guess.
        return None

    index = start
    while True:
        found = data.find(b"EI", index)
        if found < 0:
            return None
        following = data[found + 2:found + 3]
        if (found > start and data[found - 1] in _PP_WHITESPACE
                and (not following or following in _PP_WHITESPACE
                     or following in _PP_DELIMITERS)
                and _pp_inline_data_complete(data[start:found - 1], filters)):
            return found - 1, found + 2
        index = found + 2


def _pp_scan_inline_images(data):
    """
    Every inline image in one content stream, in the order they are drawn.

    None means the stream holds one whose data has no findable end, in which case
    nothing in it is touched at all: carrying on from a guessed position would
    splice into the middle of somebody else's bytes.
    """
    if b"BI" not in data:
        # Almost no content stream holds an inline image, and reading one token
        # at a time is the slowest thing this pass does. Two bytes have to be
        # there for an inline image to be, and looking for them is not.
        return []
    images = []
    index = 0
    while True:
        token = _pp_next_token(data, index)
        if token is None:
            return images
        start, index, text = token
        if text != b"BI":
            continue
        fields, index = _pp_parse_inline_dict(data, index)
        if fields is None:
            return None
        # Exactly one whitespace byte separates `ID` from the samples.
        data_start = index + 1
        extent = _pp_inline_extent(data, data_start, fields)
        if extent is None:
            return None
        data_end, index = extent
        images.append({
            "start": start, "end": index, "data": (data_start, data_end),
            "fields": fields, "described": _pp_describe_inline(fields),
        })


def _pp_decode_inline(data, fields, described):
    """
    Decode one inline image's bytes by handing them to MuPDF as an image object.

    Writing the decoders out again here would mean reimplementing six of them;
    a throwaway document with a single object gets the real ones instead.
    """
    scratch = pymupdf.open()
    try:
        xref = scratch.get_new_xref()
        scratch.update_object(xref, "<</Type/XObject/Subtype/Image>>")
        # The stream lands first: writing it clears /Filter and /DecodeParms.
        scratch.update_stream(xref, data, new=1, compress=0)
        scratch.xref_set_key(xref, "Width", str(described["width"]))
        scratch.xref_set_key(xref, "Height", str(described["height"]))
        scratch.xref_set_key(xref, "BitsPerComponent", str(described["bpc"]))
        scratch.xref_set_key(xref, "ColorSpace", "/" + described["space"])
        if described["filters"]:
            names = "".join("/" + name for name in described["filters"])
            scratch.xref_set_key(
                xref, "Filter", names if len(described["filters"]) == 1 else "[%s]" % names)
        for key in ("DecodeParms", "Decode"):
            if fields.get(key):
                scratch.xref_set_key(xref, key, fields[key])
        return pymupdf.Pixmap(scratch, xref)
    finally:
        scratch.close()


def _pp_inline_bytes(keys, data, width, height):
    """
    One `BI … ID … EI`, spelled the way MuPDF spells them.

    Only the keys the encoders here produce are written: the samples are decoded
    ones, so any /Decode or /Interpolate the original carried described something
    that no longer exists.
    """
    fields = [
        "/W %d" % width,
        "/H %d" % height,
        "/BPC %s" % keys["BitsPerComponent"],
        "/CS/%s" % _PP_SHORT_SPACES[keys["ColorSpace"].lstrip("/")],
        "/F/%s" % _PP_SHORT_FILTERS[keys["Filter"].lstrip("/")],
    ]
    if keys.get("DecodeParms", "null") != "null":
        fields.append("/DP%s" % keys["DecodeParms"])
    return b"BI" + "".join(fields).encode("latin-1") + b" ID " + data + b" EI"


def _pp_rewrite_inline_image(document, info, dpi, quality):
    """
    Re-encode one inline image in place. False means it was left alone.

    The stream is scanned again rather than trusting offsets taken when the plan
    was made, because rewriting an earlier image in the same stream moves every
    byte after it. What does not move is how many inline images the stream holds
    or the order they come in, so the position in that order still identifies
    this one.
    """
    data = document.xref_stream(info["stream"])
    if not data:
        return False
    images = _pp_scan_inline_images(data)
    if images is None or info["ordinal"] >= len(images):
        return False
    image = images[info["ordinal"]]
    described = image["described"]
    if described is None:
        return False
    try:
        pix = _pp_decode_inline(
            data[image["data"][0]:image["data"][1]], image["fields"], described)
    except Exception:
        # These are bytes found by reading a stream, not an object the document
        # vouches for, so failing to decode them is an ordinary outcome. It says
        # this image cannot be rewritten, not that the pass has gone wrong.
        return False
    if pix is None or pix.colorspace is None:
        return False
    if pix.alpha:
        pix = pymupdf.Pixmap(pix, 0)
    kind = _pp_classify_pixmap(pix)
    factor = _pp_shrink_factor(info["dpi"], dpi, pix.width, pix.height)
    if factor:
        pix.shrink(factor)
    if kind == "bitonal":
        encoded, pix, keys = _pp_encode_bitonal(pix)
    else:
        encoded, pix, keys = _pp_encode_jpeg(pix, quality, kind == "gray")
    replacement = _pp_inline_bytes(keys, encoded, pix.width, pix.height)
    # Encoded bytes can hold anything, `EI` included, and only the ones written
    # here are this pass's responsibility: read the replacement back the way any
    # reader would, and leave the image alone unless it says what it means.
    written = _pp_scan_inline_images(replacement)
    if not written or len(written) != 1 or written[0]["end"] != len(replacement):
        return False
    rewritten = data[:image["start"]] + replacement + data[image["end"]:]
    # An inline image is stored deflated along with the stream around it, so what
    # decides whether this was worth doing is the compressed size — the same
    # measure the keep-smaller guard uses for an image object. Raw samples in
    # particular deflate well enough to beat a JPEG of them now and then.
    if len(zlib.compress(rewritten, 6)) >= len(zlib.compress(data, 6)):
        return False
    document.update_stream(info["stream"], rewritten, new=1, compress=1)
    return True


def _pp_content_streams(document, page, appearance_roots):
    """
    Every stream this page draws through: its contents, the forms those use, and
    its annotation appearances — all the places an inline image can be written.
    """
    streams = list(page.get_contents())
    seen = set(streams)
    pending = _pp_xobject_references(document, page.xref) + list(appearance_roots)
    while pending:
        current = pending.pop()
        if current in seen or document.xref_is_image(current):
            continue
        seen.add(current)
        streams.append(current)
        pending.extend(_pp_xobject_references(document, current))
    return streams


def _pp_plan_images(document, dpi):
    """
    Inspect every image placement and return the rasters worth rewriting, each
    tagged with the lowest DPI it is drawn at.

    Replacement happens per object and is therefore global, so a shared image
    has to keep enough pixels for its largest placement — which is only known
    once every page has been walked.

    Inline images have no object to replace and are planned separately, by
    scanning the streams they are written into. `annotations` and `inline` count
    what each of those two extra walks found, and `unreached` counts the streams
    the second one gave up on because it could not be certain where an inline
    image ended — nothing in those is touched at all.
    """
    images = {}
    rejected = set()
    mask_xrefs = set()
    annotations = 0
    unreached = 0
    inline_dpi = {}
    streams = []
    seen_streams = set()

    def note(xref, placement_dpi):
        """Record one placement, describing the image the first time it is seen.

        A shared image is placed once per page it appears on, so both the
        description and the decision to exclude it are remembered rather than
        re-read from the object for every placement.
        """
        if xref in rejected:
            return None
        info = images.get(xref)
        if info is None:
            info = _pp_describe_image(document, xref)
            if info is None:
                rejected.add(xref)
                return None
            images[xref] = info
        if placement_dpi is not None:
            info["dpi"] = min(info["dpi"], placement_dpi)
        return info

    for page in document:
        for image in page.get_images(full=True):
            xref, mask = image[:2]
            # The reported mask is /SMask or /Mask, and neither is ever a
            # standalone image: both are rewritten with the image that owns them.
            if mask:
                mask_xrefs.add(mask)
            if xref <= 0 or note(xref, None) is None:
                continue
            for _, transform in page.get_image_rects(xref, transform=True):
                width = math.hypot(transform.a, transform.b)
                height = math.hypot(transform.c, transform.d)
                if width > 0 and height > 0:
                    note(xref, min(image[2] * 72 / width, image[3] * 72 / height))

        # Appearance streams hang off the annotation rather than the page
        # resources, so `get_images()` never reports what they draw. Their
        # placement is not known without parsing the appearance itself, so
        # assume the image fills the annotation: anything smaller is drawn at a
        # higher DPI than that, which only ever means shrinking it less.
        seen = set()
        try:
            appearances = _pp_annotation_appearances(document, page)
        except Exception:
            # A broken annotation is not worth losing the page's images over.
            appearances = []
        for roots, rect in appearances:
            for xref in _pp_appearance_images(document, roots, seen):
                info = note(xref, None)
                annotations += 1
                if info is None or rect.width <= 0 or rect.height <= 0:
                    continue
                note(xref, min(info["width"] * 72 / rect.width,
                               info["height"] * 72 / rect.height))

        # An inline image is identified by its size rather than its position,
        # because the same one drawn from a shared form appears on several pages
        # while the stream holding it is only rewritten once. Two of the same
        # size therefore share the smallest DPI either is drawn at, which can
        # only mean shrinking one of them less than it could have been.
        try:
            for placement in page.get_image_info(xrefs=True):
                if placement.get("xref"):
                    continue
                a, b, c, d = placement["transform"][:4]
                across, down = math.hypot(a, b), math.hypot(c, d)
                if across <= 0 or down <= 0:
                    continue
                size = (placement["width"], placement["height"])
                inline_dpi[size] = min(
                    inline_dpi.get(size, math.inf),
                    placement["width"] * 72 / across,
                    placement["height"] * 72 / down,
                )
        except Exception:
            pass

        try:
            page_streams = _pp_content_streams(
                document, page, [root for roots, _ in appearances for root in roots])
        except Exception:
            page_streams = []
        for xref in page_streams:
            if xref not in seen_streams:
                seen_streams.add(xref)
                streams.append(xref)

    # A soft mask only surfaces on the page that uses it, so eligibility can
    # only be decided once every page has been walked.
    threshold = max(int(dpi) + 1, round(int(dpi) * 1.15))

    def worth_rewriting(info):
        """
        A losslessly stored raster is worth re-encoding whatever size it is drawn
        at, because becoming a JPEG shrinks it on its own. Anything else is
        already lossy, or already fax-compressed, and re-encoding it at the same
        quality reliably produces a larger stream that the keep-smaller guard
        would only throw away — so it has to have resolution to give up before it
        is worth decoding at all.
        """
        return (info["filter"] in ("", "FlateDecode", "LZWDecode", "RunLengthDecode")
                or (math.isfinite(info["dpi"]) and info["dpi"] >= threshold))

    eligible = [
        info for xref, info in sorted(images.items())
        if xref not in mask_xrefs and worth_rewriting(info)
    ]

    inline = 0
    for stream in streams:
        try:
            found = _pp_scan_inline_images(document.xref_stream(stream) or b"")
        except Exception:
            found = None
        if found is None:
            # Nothing in a stream this could not follow is safe to touch, and how
            # many images it holds is exactly what could not be established.
            unreached += 1
            continue
        for ordinal, image in enumerate(found):
            described = image["described"]
            if described is None:
                continue
            info = dict(described, kind="inline", stream=stream, ordinal=ordinal,
                        dpi=inline_dpi.get((described["width"], described["height"]),
                                           math.inf))
            if worth_rewriting(info):
                eligible.append(info)
                inline += 1

    return {"images": eligible, "annotations": annotations,
            "inline": inline, "unreached": unreached}


def _pp_shrink_factor(effective_dpi, dpi, width, height):
    """How many times an image drawn at `effective_dpi` may be halved to reach `dpi`."""
    if dpi <= 0 or not math.isfinite(effective_dpi) or effective_dpi <= 0:
        return 0
    factor = 0
    while (effective_dpi / (2 ** (factor + 1)) > dpi
           and min(width, height) // (2 ** (factor + 1)) >= 1):
        factor += 1
    return factor


def _pp_classify_pixmap(pix):
    """
    Colour, gray or bitonal, decided from the samples the way MuPDF decides it.

    A DeviceRGB scan whose pixels all happen to be gray is a gray image, and one
    that is only ever black or white is bitonal; trusting the declared colour
    model instead would leave both encoded far larger than they need to be. The
    round trip through gray is exact for a pixel whose components are equal and
    inexact for every other pixel, so the digests match only for a gray image.
    """
    if pix.colorspace is None:
        return "gray"
    gray = pix
    if pix.colorspace.n != 1:
        gray = pymupdf.Pixmap(pymupdf.csGRAY, pix)
        if pymupdf.Pixmap(pix.colorspace, gray).digest != pix.digest:
            return "color"
    return "bitonal" if gray.is_monochrome else "gray"


def _pp_encode_bitonal(pix):
    """
    Halftone to one bit and compress as CCITT Group 4.

    Both polarities are tried because G4 encodes runs of white far more cheaply
    than runs of black, and a scan that has been inverted somewhere in its life
    costs several times more the wrong way round. Naming the winner costs the
    fifteen bytes of a /BlackIs1 entry, so it has to beat the default by more
    than that to be worth choosing.
    """
    if pix.colorspace is None or pix.colorspace.n != 1:
        pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
    fax = pymupdf.mupdf
    bitmap = fax.fz_new_bitmap_from_pixmap(pix.this, fax.fz_default_halftone(1))
    normal = fax.fz_buffer_extract(
        fax.fz_compress_ccitt_fax_g4(bitmap.samples(), bitmap.w(), bitmap.h(), bitmap.stride()))
    fax.fz_invert_bitmap(bitmap)
    inverted = fax.fz_buffer_extract(
        fax.fz_compress_ccitt_fax_g4(bitmap.samples(), bitmap.w(), bitmap.h(), bitmap.stride()))
    black_is_1 = len(normal) + 15 < len(inverted)
    return (normal if black_is_1 else inverted), pix, {
        "Filter": "/CCITTFaxDecode",
        "DecodeParms": "<</K -1/Columns %d/Rows %d%s>>" % (
            pix.width, pix.height, "/BlackIs1 true" if black_is_1 else ""),
        "ColorSpace": "/DeviceGray",
        "BitsPerComponent": "1",
    }


def _pp_encode_jpeg(pix, quality, gray):
    """
    Recompress as JPEG, converting only when the component count has to change.

    An ICC-tagged raster is relabelled with the matching device space rather
    than converted through its profile: the samples are already what they were,
    and a conversion would cost a full extra pass over the image to move them.
    """
    if gray:
        if pix.colorspace.n != 1:
            pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
    elif pix.colorspace.n not in (1, 3):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    return pix.tobytes("jpeg", jpg_quality=int(quality)), pix, {
        "Filter": "/DCTDecode",
        "DecodeParms": "null",
        "ColorSpace": "/DeviceGray" if pix.colorspace.n == 1 else "/DeviceRGB",
        "BitsPerComponent": "8",
    }


def _pp_replace_image_stream(document, xref, data, keys, width, height):
    """
    Swap one image object's bytes and the dictionary entries that describe them.

    The stream has to land first: writing it clears /Filter and /DecodeParms,
    because the bytes it was handed are no longer described by whatever encoded
    the old ones. Setting the keys beforehand would silently lose them.
    """
    document.update_stream(xref, data, new=1, compress=0)
    document.xref_set_key(xref, "Width", str(width))
    document.xref_set_key(xref, "Height", str(height))
    # A /Decode array written for the old samples would remap the new ones.
    document.xref_set_key(xref, "Decode", "null")
    for key, value in keys.items():
        document.xref_set_key(xref, key, value)


def _pp_stream_length(document, xref):
    try:
        return len(document.xref_stream_raw(xref) or b"")
    except Exception:
        return 0


def _pp_rewrite_smask(document, xref, factor):
    """
    Shrink an image's soft mask by as much as the image itself shrank.

    MuPDF leaves masks alone, which can leave a downsampled photograph carrying
    a full-resolution alpha channel several times its size. The two are scaled
    onto the same area regardless of their pixel dimensions, so they only have
    to shrink together, not match.
    """
    mask = pymupdf.Pixmap(document, xref)
    if mask.alpha:
        mask = pymupdf.Pixmap(mask, 0)
    if mask.colorspace is None or mask.colorspace.n != 1:
        mask = pymupdf.Pixmap(pymupdf.csGRAY, mask)
    mask.shrink(factor)
    data = zlib.compress(mask.samples, 6)
    if len(data) >= _pp_stream_length(document, xref):
        return False
    _pp_replace_image_stream(document, xref, data, {
        "Filter": "/FlateDecode",
        "DecodeParms": "null",
        "ColorSpace": "/DeviceGray",
        "BitsPerComponent": "8",
    }, mask.width, mask.height)
    return True


def _pp_rewrite_image(document, info, dpi, quality):
    """Shrink and recompress one planned raster. False means it was left alone."""
    if info["kind"] == "inline":
        return _pp_rewrite_inline_image(document, info, dpi, quality)
    xref = info["xref"]
    original = _pp_stream_length(document, xref)
    pix = pymupdf.Pixmap(document, xref)
    if pix.colorspace is None:
        return False
    if pix.alpha:
        # No output format here carries alpha, and the soft mask that holds it
        # is a separate object rewritten on its own below.
        pix = pymupdf.Pixmap(pix, 0)
    # Classify before resampling, as MuPDF does, so a bitonal scan stays on the
    # fax path and is halftoned back to one bit after it shrinks.
    kind = _pp_classify_pixmap(pix)
    factor = _pp_shrink_factor(info["dpi"], dpi, pix.width, pix.height)
    if factor:
        pix.shrink(factor)
    if kind == "bitonal":
        data, pix, keys = _pp_encode_bitonal(pix)
    else:
        data, pix, keys = _pp_encode_jpeg(pix, quality, kind == "gray")
    # Keep whichever is smaller, even when that means keeping full resolution:
    # an image that was already tightly packed can only grow from here.
    if original and len(data) >= original:
        return False
    _pp_replace_image_stream(document, xref, data, keys, pix.width, pix.height)
    if factor and info["smask"]:
        try:
            _pp_rewrite_smask(document, info["smask"], factor)
        except Exception:
            # The image itself is already smaller; an untouched mask still
            # describes the same area, so this is not worth failing the page for.
            pass
    return True


def _pp_downsample_images(document, dpi, quality):
    """
    Shrink embedded rasters towards `dpi`, then recompress them at `quality`.
    `dpi` is a floor: the pass halves while the result stays above it, so an
    image it cannot halve is still recompressed. The threshold sits just above
    the floor so images already at or below it are left alone entirely.
    """
    for info in _pp_plan_images(document, dpi)["images"]:
        _pp_rewrite_image(document, info, dpi, quality)


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
    ahead, without doing any of it. Every image is then rewritten one at a time,
    so the counts let the caller show real progress over the whole of it.
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
    annotations = 0
    inline = 0
    unreached = 0
    if job["image_dpi"]:
        try:
            plan = _pp_plan_images(output, job["image_dpi"])
        except Exception as error:
            _pp_handle_finalize_error(job, error)
        else:
            job["image_plan"] = plan["images"]
            annotations = plan["annotations"]
            inline = plan["inline"]
            unreached = plan["unreached"]
    return json.dumps({
        "images": len(job["image_plan"]),
        "annotations": annotations,
        "inline": inline,
        "unreached": unreached,
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
        changed = _pp_rewrite_image(
            job["output"],
            plan[index],
            job["image_dpi"],
            int(job["settings"]["jpegQuality"]),
        )
    except Exception as error:
        _pp_handle_finalize_error(job, error)
        return json.dumps({"stopped": True, "changed": False})
    return json.dumps({"stopped": False, "changed": bool(changed)})


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
