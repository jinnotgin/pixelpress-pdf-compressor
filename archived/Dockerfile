FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
# You might need to install system dependencies for PyMuPDF if not in base image
# RUN apt-get update && apt-get install -y --no-install-recommends some-lib-mupdf-needs && rm -rf /var/lib/apt/lists/*

COPY . .

# Expose the port Gunicorn will run on
EXPOSE 8080

# Command to run the application using Gunicorn
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "app:app"]