import os
import threading
from monitor import monitor_loop
from app import init_db  # <-- ADD THIS LINE to import the function

# --- Gunicorn Configuration ---

# Get the absolute path of the directory where this config is located.
bind_dir = os.path.dirname(os.path.abspath(__file__))

# Server Socket
bind = f"{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '7001')}"
backlog = 2048

# Worker Processes
# Smartly set worker count based on CPU cores.
# A common formula for I/O-bound apps is (2 * num_cores) + 1.
# Since our task is CPU-bound, num_cores is a safer bet.
default_workers = os.cpu_count() or 2
workers = int(os.environ.get('GUNICORN_WORKERS', default_workers))

# Use the 'gthread' worker class for multi-threading within a worker process.
# Each worker will have its own PDF processing thread pool.
worker_class = "gthread"
# threads = int(os.environ.get('GUNICORN_THREADS', 2)) # Threads per worker

# Set a long timeout to allow for lengthy PDF processing tasks.
timeout = 1800 # 30 minutes, in seconds

# Restart workers after a certain number of requests to prevent memory leaks.
# The PDF processing is memory-intensive, so restarting after each task is a robust strategy.
max_requests = 1
# max_requests_jitter = 5 # Add randomness to avoid all workers restarting simultaneously.

# Logging
accesslog = "-"  # Log access to stdout
errorlog = "-"   # Log errors to stderr
loglevel = "info"
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'

# Change the process name for easier identification.
proc_name = "pdf_processor_app"

# Ensure Gunicorn runs in the correct directory.
chdir = bind_dir

# --- Server Hooks for Monitor Thread ---
# Gunicorn provides hooks to run code at different stages of the server's life.
# We use `when_ready` to start our monitor in the master process before workers are forked.

monitor_thread = None
stop_monitor_event = threading.Event()

def when_ready(server):
    """Called just after the master process is initialized."""
    # --- FIX: Initialize the database from the master process ---
    # This ensures the DB and tables exist before the monitor or any worker tries to access them.
    server.log.info("Master process is ready. Initializing database...")
    init_db()
    server.log.info("Database initialization complete.")

    global monitor_thread
    monitor_thread = threading.Thread(
        target=monitor_loop,
        args=(stop_monitor_event,),
        name="AppMonitorThread"
    )
    monitor_thread.daemon = True
    monitor_thread.start()
    server.log.info("Started application monitor thread in master process.")

def on_exit(server):
    """Called just before the master process exits."""
    global monitor_thread
    server.log.info("Gunicorn master shutting down. Signaling monitor to stop...")
    stop_monitor_event.set()
    if monitor_thread:
        # Wait a moment for the thread to finish cleanly.
        monitor_thread.join(timeout=5)
    server.log.info("Monitor thread has been shut down.")