#!/usr/bin/env python3

import fitz  # PyMuPDF
import argparse
import os
import sys

def rasterize_pdf_to_new_pdf(input_pdf_path, output_pdf_path, dpi=72):
    """
    Rasterizes each page of an input PDF to an image and saves these images
    as pages in a new PDF.

    Args:
        input_pdf_path (str): Path to the input PDF file.
        output_pdf_path (str): Path to save the new rasterized PDF file.
        dpi (int): Dots Per Inch for rasterization.
    """
    if not os.path.exists(input_pdf_path):
        print(f"Error: Input PDF not found at '{input_pdf_path}'")
        return False

    try:
        # Open the source PDF
        input_doc = fitz.open(input_pdf_path)
    except Exception as e:
        print(f"Error opening input PDF '{input_pdf_path}': {e}")
        return False

    # Create a new PDF to store rasterized pages
    output_doc = fitz.open()

    print(f"Processing '{input_pdf_path}'...")
    num_pages = len(input_doc)

    for page_num in range(num_pages):
        print(f"  Rasterizing page {page_num + 1}/{num_pages} at {dpi} DPI...")
        try:
            page = input_doc.load_page(page_num)

            # Rasterize page to a pixmap
            # The matrix defines scaling. Default matrix is fitz.Identity
            # To scale by DPI, we can use a matrix that scales by dpi/72
            # MuPDF's default rendering is 72 DPI.
            zoom = dpi / 72.0
            matrix = fitz.Matrix(zoom, zoom)
            pix = page.get_pixmap(matrix=matrix, alpha=False) # alpha=False for no transparency

            # Create a new page in the output PDF with the dimensions of the image
            # Page dimensions in PDF are in points (1/72 inch)
            # Image width/height in pixels.
            # Page width in points = pix.width * (72 / dpi)
            # Page height in points = pix.height * (72 / dpi)
            # However, pix.width and pix.height are already scaled by the matrix.
            # So, the page dimensions should match pix.width and pix.height if we consider
            # the internal PDF coordinate system where 1 unit = 1 pixel for an image.
            # More simply, PyMuPDF's page.insert_pdfpage uses the pixmap's dimensions.

            # Create a new page matching the image's dimensions
            # The rect for inserting the image will be (0, 0, pix.width, pix.height)
            # PyMuPDF uses points for page dimensions.
            # If pix.width and pix.height are dimensions at `dpi`,
            # then page_width_pt = pix.width * 72 / dpi
            # page_height_pt = pix.height * 72 / dpi
            # However, fitz.Page.insert_image takes care of scaling if we provide pixmap
            
            # Get image dimensions in points for the new PDF page
            page_width_pt = pix.width * 72.0 / dpi
            page_height_pt = pix.height * 72.0 / dpi
            
            new_page = output_doc.new_page(width=page_width_pt, height=page_height_pt)

            # Insert the rasterized image onto the new page
            # The image will fill the entire page
            new_page.insert_image(new_page.rect, pixmap=pix)

            pix = None # free pixmap resources
            page = None # free page resources

        except Exception as e:
            print(f"Error processing page {page_num + 1}: {e}")
            # Optionally, decide if you want to skip or halt
            # For now, let's try to continue if possible
            continue

    if len(output_doc) == 0 and num_pages > 0:
        print("Error: No pages were added to the output PDF. This might indicate an issue during processing.")
        input_doc.close()
        output_doc.close()
        return False
    elif len(output_doc) == 0 and num_pages == 0:
        print("Input PDF has no pages. Output PDF will also be empty.")
    
    try:
        # Save the new PDF
        # garbage=4 cleans up unused objects, deflate compresses streams
        output_doc.save(output_pdf_path, garbage=4, deflate=True)
        print(f"\nSuccessfully created rasterized PDF: '{output_pdf_path}'")
        return True
    except Exception as e:
        print(f"Error saving output PDF '{output_pdf_path}': {e}")
        return False
    finally:
        input_doc.close()
        output_doc.close()

def main():
    parser = argparse.ArgumentParser(
        description="Rasterize a PDF to images and save them into a new PDF.",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("input_pdf", help="Path to the input PDF file.")
    parser.add_argument("output_pdf", help="Path to save the new rasterized PDF file.")
    parser.add_argument(
        "--dpi",
        type=int,
        default=72,
        help="Resolution in DPI for rasterizing pages (default: 72)."
    )

    if len(sys.argv) == 1:
        parser.print_help(sys.stderr)
        sys.exit(1)

    args = parser.parse_args()

    if args.input_pdf == args.output_pdf:
        print("Error: Input and output PDF paths cannot be the same.")
        sys.exit(1)
        
    # Basic check for PDF extension, though not foolproof
    if not args.input_pdf.lower().endswith(".pdf"):
        print(f"Warning: Input file '{args.input_pdf}' does not have a .pdf extension.")
    if not args.output_pdf.lower().endswith(".pdf"):
        print(f"Warning: Output file '{args.output_pdf}' does not have a .pdf extension. It will be saved as PDF anyway.")


    success = rasterize_pdf_to_new_pdf(args.input_pdf, args.output_pdf, args.dpi)
    if success:
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
