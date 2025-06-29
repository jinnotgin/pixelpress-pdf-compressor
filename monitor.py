import time
import sqlite3
import logging
import os
import psutil # You'll need to add this to requirements.txt

# --- Configuration ---
DATABASE_FILE = 'tasks.db'
# How long a task can go without a heartbeat before we check if its worker is dead (in seconds)
STALE_TASK_THRESHOLD_SECONDS = 300  # 5 minutes
# How often the monitor checks for stale tasks (in seconds)
MONITOR_LOOP_SLEEP_SECONDS = 60 # 1 minute
# How often to run the full cleanup of old, completed tasks
CLEANUP_INTERVAL_SECONDS = 3600 # 1 hour
# How old a completed/failed task must be to be deleted
CLEANUP_AGE_HOURS = 72


# Set up a logger specific to the monitor
log = logging.getLogger('monitor')
log.setLevel(logging.INFO)
handler = logging.StreamHandler()
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)
if not log.handlers:
    log.addHandler(handler)

def get_db_connection():
    """Establishes a connection to the SQLite database."""
    # The monitor runs in its own thread, so `check_same_thread=False` is safe here.
    conn = sqlite3.connect(DATABASE_FILE, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def mark_task_as_failed(task_id, reason):
    """Updates a task's status to 'failed' in the database."""
    log.warning(f"Marking task {task_id} as failed. Reason: {reason}")
    conn = None
    try:
        conn = get_db_connection()
        conn.execute(
            "UPDATE task_status SET status = 'failed', message = ?, timestamp_last_updated = ? WHERE task_id = ?",
            (reason, time.time(), task_id)
        )
        conn.commit()
    except sqlite3.Error as e:
        log.error(f"DB Error while failing task {task_id}: {e}")
    finally:
        if conn: conn.close()

def cleanup_and_delete_task_record(task_id):
    """Removes files and the database entry for a given task_id."""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT input_path, output_path FROM task_status WHERE task_id = ?", (task_id,))
        task_row = cursor.fetchone()

        if task_row:
            paths_to_clean = filter(None, [task_row['input_path'], task_row['output_path']])
            for file_path in paths_to_clean:
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                        log.info(f"Cleanup: Removed file {file_path} for task {task_id}")
                    except OSError as e:
                        log.error(f"Cleanup: Error removing file {file_path} for task {task_id}: {e}")

            cursor.execute("DELETE FROM task_status WHERE task_id = ?", (task_id,))
            conn.commit()
            log.info(f"Cleanup: Removed task record {task_id} from DB.")
            return True
        return False
    except sqlite3.Error as e:
        log.error(f"DB Error during cleanup for task {task_id}: {e}", exc_info=True)
        return False
    finally:
        if conn: conn.close()


def check_stale_tasks():
    """
    Finds tasks that are 'processing' but haven't sent a heartbeat recently.
    If the worker PID for a stale task no longer exists, marks the task as failed.
    """
    log.info("Watchdog: Checking for stale/orphaned tasks...")
    conn = None
    try:
        conn = get_db_connection()
        stale_threshold = time.time() - STALE_TASK_THRESHOLD_SECONDS
        
        # Find tasks that are processing and have a heartbeat older than our threshold
        stale_tasks = conn.execute(
            "SELECT task_id, worker_pid, original_filename FROM task_status WHERE status = 'processing' AND heartbeat_timestamp < ?",
            (stale_threshold,)
        ).fetchall()

        if not stale_tasks:
            log.info("Watchdog: No stale tasks found.")
            return

        for task in stale_tasks:
            task_id, worker_pid, filename = task['task_id'], task['worker_pid'], task['original_filename']
            log.warning(f"Watchdog: Task {task_id} ('{filename}') is stale. Checking worker PID: {worker_pid}.")

            if worker_pid is None:
                mark_task_as_failed(task_id, "Task failed due to missing worker process ID.")
                continue

            # This is the crucial check to prevent false positives.
            if not psutil.pid_exists(worker_pid):
                # The process is truly gone. It's an orphan.
                log.error(f"Watchdog: Worker PID {worker_pid} for task {task_id} is GONE. Marking task as failed.")
                mark_task_as_failed(task_id, "Task failed due to vanished or crashed worker process.")
            else:
                # The process is still alive, just very busy or stuck. We'll leave it alone.
                log.warning(f"Watchdog: Worker PID {worker_pid} for task {task_id} is still alive but not sending heartbeats. Monitoring.")

    except sqlite3.Error as e:
        log.error(f"Watchdog: Database error while checking for stale tasks: {e}", exc_info=True)
    except Exception as e:
        log.error(f"Watchdog: An unexpected error occurred: {e}", exc_info=True)
    finally:
        if conn: conn.close()


def run_periodic_cleanup():
    """Finds and deletes old 'completed' or 'failed' tasks and their files."""
    log.info("Cleanup: Running hourly cleanup of old tasks...")
    conn = None
    try:
        conn = get_db_connection()
        cleanup_threshold_seconds = float(os.environ.get("CLEANUP_AFTER_HOURS", CLEANUP_AGE_HOURS)) * 3600
        older_than_timestamp = time.time() - cleanup_threshold_seconds

        tasks_to_remove = conn.execute("""
            SELECT task_id FROM task_status
            WHERE status IN ('completed', 'failed') AND timestamp_last_updated < ?
        """, (older_than_timestamp,)).fetchall()
        
        if not tasks_to_remove:
            log.info("Cleanup: No old tasks met the criteria for removal.")
            return
        
        log.info(f"Cleanup: Found {len(tasks_to_remove)} old task(s) to remove.")
        deleted_count = 0
        for task_row in tasks_to_remove:
            if cleanup_and_delete_task_record(task_row['task_id']):
                deleted_count += 1
        
        log.info(f"Cleanup finished. Removed {deleted_count} old task(s).")

    except sqlite3.Error as e:
        log.error(f"Cleanup: Database error during cleanup: {e}", exc_info=True)
    except Exception as e:
        log.error(f"Cleanup: General error during cleanup: {e}", exc_info=True)
    finally:
        if conn: conn.close()


def monitor_loop(stop_event):
    """
    The main loop for the monitor thread.
    - Runs `check_stale_tasks` periodically.
    - Runs `run_periodic_cleanup` less frequently.
    """
    log.info("Monitor thread started.")
    last_cleanup_time = 0
    while not stop_event.is_set():
        try:
            check_stale_tasks()

            # Run the big cleanup job periodically
            if time.time() - last_cleanup_time > CLEANUP_INTERVAL_SECONDS:
                run_periodic_cleanup()
                last_cleanup_time = time.time()

            # Wait until the next check or until a stop is requested
            stop_event.wait(MONITOR_LOOP_SLEEP_SECONDS)

        except Exception as e:
            log.critical(f"Fatal error in monitor loop: {e}", exc_info=True)
            # Sleep a bit before retrying to avoid spamming logs on repeated failures
            time.sleep(60)

    log.info("Monitor thread shutting down.")