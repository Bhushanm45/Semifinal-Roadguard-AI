"""
RoadGuard AI - SQLite Database Persistence Layer
================================================
Manages schemas, connection pooling, and CRUD transactions for:
1. `raw_detections`: Individual classified sensor windows with hardware telemetry & GPS accuracy.
2. `hotspots`: Aggregated geographic road hazard clusters with priority scoring and mode partitioning.
3. `status_history`: Audit trail for municipal inspection and repair transitions.
4. `devices`: Edge ESP32 device registry, connection state, and GPS health monitoring.
"""

import os
import sqlite3
from datetime import datetime
from typing import Dict, Any, List, Optional

DEFAULT_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "roadguard.db"))


def get_db_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Creates a connection to SQLite database with Row factory enabled."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_column_exists(cursor: sqlite3.Cursor, table_name: str, column_name: str, column_def: str):
    """Safely adds a column to an existing table if it does not already exist."""
    cursor.execute(f"PRAGMA table_info({table_name})")
    columns = [row[1] for row in cursor.fetchall()]
    if column_name not in columns:
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_def}")


def init_db(db_path: str = DEFAULT_DB_PATH):
    """Initializes tables, columns, and indexes if they do not exist."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # 1. Raw Detections Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS raw_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        ride_id TEXT NOT NULL,
        device_id TEXT,
        hazard_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        severity_metric REAL,
        latitude REAL,
        longitude REAL,
        gps_valid INTEGER DEFAULT 0,
        hotspot_id INTEGER,
        created_at TEXT NOT NULL
    )
    """)

    # Migrations for raw_detections
    _ensure_column_exists(cursor, "raw_detections", "mode", "TEXT DEFAULT 'HARDWARE'")
    _ensure_column_exists(cursor, "raw_detections", "seq_num", "INTEGER DEFAULT 0")
    _ensure_column_exists(cursor, "raw_detections", "satellites", "INTEGER DEFAULT 0")
    _ensure_column_exists(cursor, "raw_detections", "hdop", "REAL DEFAULT 1.0")
    _ensure_column_exists(cursor, "raw_detections", "is_stale", "INTEGER DEFAULT 0")

    # 2. Aggregated Hotspots Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS hotspots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hazard_type TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        location_name TEXT,
        observation_count INTEGER DEFAULT 1,
        distinct_rides INTEGER DEFAULT 1,
        avg_confidence REAL NOT NULL,
        max_severity REAL NOT NULL,
        priority_score INTEGER NOT NULL,
        priority_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DETECTED',
        first_detected_at TEXT NOT NULL,
        last_detected_at TEXT NOT NULL,
        notes TEXT
    )
    """)

    # Migrations for hotspots
    _ensure_column_exists(cursor, "hotspots", "mode", "TEXT DEFAULT 'HARDWARE'")

    # 3. Status Audit History Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotspot_id INTEGER NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        notes TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (hotspot_id) REFERENCES hotspots (id)
    )
    """)

    # 4. Connected Devices Registry Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL,
        ip_address TEXT,
        status TEXT NOT NULL DEFAULT 'ONLINE',
        gps_fix INTEGER DEFAULT 0,
        satellites INTEGER DEFAULT 0,
        hdop REAL DEFAULT 0.0,
        last_seq_num INTEGER DEFAULT 0,
        firmware_version TEXT DEFAULT '1.0.0'
    )
    """)

    _ensure_column_exists(cursor, "devices", "latitude", "REAL")
    _ensure_column_exists(cursor, "devices", "longitude", "REAL")
    _ensure_column_exists(cursor, "devices", "speed_kmh", "REAL DEFAULT 0.0")
    _ensure_column_exists(cursor, "devices", "last_gps_fix_at", "TEXT")
    _ensure_column_exists(cursor, "devices", "is_stale", "INTEGER DEFAULT 0")
    _ensure_column_exists(cursor, "devices", "mode", "TEXT DEFAULT 'HARDWARE'")

    # Indexes for fast spatial, status, and mode querying
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_hotspots_status ON hotspots(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_hotspots_type ON hotspots(hazard_type)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_hotspots_mode ON hotspots(mode)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_raw_hotspot ON raw_detections(hotspot_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_raw_ride ON raw_detections(ride_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_raw_mode ON raw_detections(mode)")

    conn.commit()
    conn.close()


def insert_raw_detection(detection: Dict[str, Any], db_path: str = DEFAULT_DB_PATH) -> int:
    """Inserts a single eligible hazard detection record."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    gps = detection.get("gps", {})
    cursor.execute("""
        INSERT INTO raw_detections (
            timestamp_ms, ride_id, device_id, hazard_type, confidence,
            severity_metric, latitude, longitude, gps_valid, created_at,
            mode, seq_num, satellites, hdop, is_stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        detection.get("timestamp_ms", int(datetime.now().timestamp() * 1000)),
        detection.get("ride_id", "UNKNOWN_RIDE"),
        detection.get("device_id", "ESP32_BUS_01"),
        detection.get("class"),
        detection.get("confidence", 0.0),
        detection.get("severity_metric", 0.0),
        gps.get("latitude"),
        gps.get("longitude"),
        1 if gps.get("valid") else 0,
        datetime.now().isoformat(),
        detection.get("mode", "HARDWARE"),
        detection.get("seq_num", 0),
        gps.get("satellites", 0),
        gps.get("hdop", 1.0),
        1 if gps.get("is_stale") else 0
    ))
    row_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return row_id


def link_detection_to_hotspot(detection_id: int, hotspot_id: int, db_path: str = DEFAULT_DB_PATH):
    """Links a raw detection to its parent hotspot cluster."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("UPDATE raw_detections SET hotspot_id = ? WHERE id = ?", (hotspot_id, detection_id))
    conn.commit()
    conn.close()


def update_device_heartbeat(
    device_id: str,
    ip_address: str,
    gps_fix: bool,
    satellites: int = 0,
    hdop: float = 1.0,
    seq_num: int = 0,
    firmware_version: str = "1.0.0",
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    speed_kmh: float = 0.0,
    is_stale: bool = False,
    mode: str = "HARDWARE",
    db_path: str = DEFAULT_DB_PATH
):
    """Updates device presence and GPS telemetry health in the database."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    now_iso = datetime.now().isoformat()

    # Query existing device to retain last known valid fix if current fix is searching
    cursor.execute("SELECT latitude, longitude, last_gps_fix_at FROM devices WHERE device_id = ?", (device_id,))
    existing = cursor.fetchone()

    final_lat = latitude if gps_fix and latitude is not None else (existing["latitude"] if existing else None)
    final_lon = longitude if gps_fix and longitude is not None else (existing["longitude"] if existing else None)
    final_gps_fix_at = now_iso if (gps_fix and latitude is not None) else (existing["last_gps_fix_at"] if existing else None)

    cursor.execute("""
        INSERT INTO devices (
            device_id, last_seen, ip_address, status, gps_fix, satellites, hdop, 
            last_seq_num, firmware_version, latitude, longitude, speed_kmh, last_gps_fix_at, is_stale, mode
        )
        VALUES (?, ?, ?, 'ONLINE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            last_seen = excluded.last_seen,
            ip_address = excluded.ip_address,
            status = 'ONLINE',
            gps_fix = excluded.gps_fix,
            satellites = excluded.satellites,
            hdop = excluded.hdop,
            last_seq_num = excluded.last_seq_num,
            firmware_version = excluded.firmware_version,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            speed_kmh = excluded.speed_kmh,
            last_gps_fix_at = excluded.last_gps_fix_at,
            is_stale = excluded.is_stale,
            mode = excluded.mode
    """, (
        device_id, now_iso, ip_address, 1 if gps_fix else 0, satellites, hdop,
        seq_num, firmware_version, final_lat, final_lon, speed_kmh, final_gps_fix_at,
        1 if is_stale else 0, mode
    ))
    conn.commit()
    conn.close()


def get_registered_devices(db_path: str = DEFAULT_DB_PATH, offline_timeout_seconds: float = 12.0) -> List[Dict[str, Any]]:
    """Retrieves all registered devices and dynamically calculates online/offline and GPS freshness status."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM devices ORDER BY last_seen DESC")
    rows = cursor.fetchall()
    conn.close()

    now = datetime.now()
    results = []
    for r in rows:
        d = dict(r)
        try:
            last_dt = datetime.fromisoformat(d["last_seen"])
            elapsed = (now - last_dt).total_seconds()
            d["seconds_since_seen"] = round(elapsed, 1)
            d["status"] = "ONLINE" if elapsed <= offline_timeout_seconds else "OFFLINE"
        except Exception:
            d["seconds_since_seen"] = 999.0
            d["status"] = "OFFLINE"

        # Calculate time since last valid GPS fix
        if d.get("last_gps_fix_at"):
            try:
                gps_dt = datetime.fromisoformat(d["last_gps_fix_at"])
                gps_elapsed = (now - gps_dt).total_seconds()
                d["seconds_since_gps_fix"] = round(gps_elapsed, 1)
                # If GPS fix is older than 10s or device is offline, mark as stale
                if gps_elapsed > 10.0 or d["status"] == "OFFLINE":
                    d["is_stale"] = 1
            except Exception:
                d["seconds_since_gps_fix"] = None
        else:
            d["seconds_since_gps_fix"] = None

        # Calculate estimated accuracy from HDOP (~5m per HDOP unit)
        hdop = d.get("hdop") or 1.0
        d["estimated_accuracy_m"] = round(float(hdop) * 5.0, 1)

        results.append(d)

    # Sort: ONLINE devices first, then newest last_seen
    results.sort(key=lambda x: (1 if x.get("status") == "ONLINE" else 0, x.get("last_seen", "")), reverse=True)
    return results


def get_all_hotspots(
    status_filter: Optional[str] = None,
    mode_filter: Optional[str] = "ALL",
    db_path: str = DEFAULT_DB_PATH
) -> List[Dict[str, Any]]:
    """Retrieves all aggregated hotspots, optionally filtered by repair status and mode (HARDWARE/SIMULATION)."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    
    query = "SELECT * FROM hotspots WHERE 1=1"
    params = []

    if status_filter and status_filter != "ALL":
        query += " AND status = ?"
        params.append(status_filter)

    if mode_filter and mode_filter != "ALL":
        query += " AND mode = ?"
        params.append(mode_filter)

    query += " ORDER BY priority_score DESC, last_detected_at DESC"
    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_hotspot_by_id(hotspot_id: int, db_path: str = DEFAULT_DB_PATH) -> Optional[Dict[str, Any]]:
    """Retrieves a single hotspot by primary key."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM hotspots WHERE id = ?", (hotspot_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def update_hotspot_status(
    hotspot_id: int,
    new_status: str,
    updated_by: str = "Municipal Engineer",
    notes: str = "",
    db_path: str = DEFAULT_DB_PATH
) -> bool:
    """Updates the repair workflow status with audit logging."""
    VALID_STATUSES = ["DETECTED", "INSPECTION_REQUESTED", "REPAIR_IN_PROGRESS", "VERIFIED"]
    if new_status not in VALID_STATUSES:
        raise ValueError(f"Invalid status '{new_status}'. Allowed: {VALID_STATUSES}")

    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    cursor.execute("SELECT status FROM hotspots WHERE id = ?", (hotspot_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return False

    old_status = row["status"]
    now_str = datetime.now().isoformat()

    cursor.execute("UPDATE hotspots SET status = ?, notes = ? WHERE id = ?", (new_status, notes, hotspot_id))
    cursor.execute("""
        INSERT INTO status_history (hotspot_id, old_status, new_status, updated_by, notes, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (hotspot_id, old_status, new_status, updated_by, notes, now_str))

    conn.commit()
    conn.close()
    return True


def get_system_statistics(mode_filter: str = "ALL", db_path: str = DEFAULT_DB_PATH) -> Dict[str, Any]:
    """Computes summary KPI statistics for municipal dashboard cards with mode filtering."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    mode_clause = ""
    params = []
    if mode_filter and mode_filter != "ALL":
        mode_clause = " WHERE mode = ?"
        params = [mode_filter]

    cursor.execute(f"SELECT COUNT(*) FROM hotspots{mode_clause}", tuple(params))
    total_hotspots = cursor.fetchone()[0]

    open_clause = "WHERE status != 'VERIFIED'" + (f" AND mode = '{mode_filter}'" if mode_filter != "ALL" else "")
    cursor.execute(f"SELECT COUNT(*) FROM hotspots {open_clause}")
    open_reports = cursor.fetchone()[0]

    high_clause = "WHERE priority_level = 'HIGH' AND status != 'VERIFIED'" + (f" AND mode = '{mode_filter}'" if mode_filter != "ALL" else "")
    cursor.execute(f"SELECT COUNT(*) FROM hotspots {high_clause}")
    high_priority = cursor.fetchone()[0]

    med_clause = "WHERE priority_level = 'MEDIUM' AND status != 'VERIFIED'" + (f" AND mode = '{mode_filter}'" if mode_filter != "ALL" else "")
    cursor.execute(f"SELECT COUNT(*) FROM hotspots {med_clause}")
    medium_priority = cursor.fetchone()[0]

    res_clause = "WHERE status = 'VERIFIED'" + (f" AND mode = '{mode_filter}'" if mode_filter != "ALL" else "")
    cursor.execute(f"SELECT COUNT(*) FROM hotspots {res_clause}")
    resolved = cursor.fetchone()[0]

    raw_mode_clause = f" WHERE mode = '{mode_filter}'" if mode_filter != "ALL" else ""
    cursor.execute(f"SELECT COUNT(DISTINCT device_id) FROM raw_detections{raw_mode_clause}")
    active_buses = max(1, cursor.fetchone()[0])

    type_clause = f" WHERE mode = '{mode_filter}'" if mode_filter != "ALL" else ""
    cursor.execute(f"SELECT hazard_type, COUNT(*) as cnt FROM hotspots{type_clause} GROUP BY hazard_type")
    type_counts = {row["hazard_type"]: row["cnt"] for row in cursor.fetchall()}

    conn.close()

    return {
        "total_hotspots": total_hotspots,
        "open_reports": open_reports,
        "high_priority": high_priority,
        "medium_priority": medium_priority,
        "resolved": resolved,
        "active_buses": active_buses,
        "type_counts": type_counts,
        "mode": mode_filter
    }


def get_recent_raw_detections(
    limit: int = 50,
    mode_filter: str = "ALL",
    hazard_type: str = "ALL",
    db_path: str = DEFAULT_DB_PATH
) -> List[Dict[str, Any]]:
    """Retrieves recent individual classified hazard detections with GPS telemetry."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    query = "SELECT * FROM raw_detections WHERE 1=1"
    params = []

    if mode_filter and mode_filter != "ALL":
        query += " AND mode = ?"
        params.append(mode_filter)

    if hazard_type and hazard_type != "ALL":
        query += " AND hazard_type = ?"
        params.append(hazard_type)

    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_analytics_summary(mode_filter: str = "ALL", db_path: str = DEFAULT_DB_PATH) -> Dict[str, Any]:
    """Computes comprehensive aggregated analytics for charts and reporting."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    mode_clause = ""
    params = []
    if mode_filter and mode_filter != "ALL":
        mode_clause = " WHERE mode = ?"
        params = [mode_filter]

    # Total hotspots & raw detections
    cursor.execute(f"SELECT COUNT(*) FROM hotspots{mode_clause}", tuple(params))
    total_hotspots = cursor.fetchone()[0]

    raw_clause = f" WHERE mode = '{mode_filter}'" if mode_filter != "ALL" else ""
    cursor.execute(f"SELECT COUNT(*) FROM raw_detections{raw_clause}")
    total_raw_detections = cursor.fetchone()[0]

    # By Hazard Type
    cursor.execute(f"SELECT hazard_type, COUNT(*) as cnt FROM hotspots{mode_clause} GROUP BY hazard_type ORDER BY cnt DESC", tuple(params))
    by_type = {row["hazard_type"]: row["cnt"] for row in cursor.fetchall()}

    # By Status
    cursor.execute(f"SELECT status, COUNT(*) as cnt FROM hotspots{mode_clause} GROUP BY status", tuple(params))
    by_status = {row["status"]: row["cnt"] for row in cursor.fetchall()}

    # Ensure all 4 standard workflow statuses exist in dict
    for st in ["DETECTED", "INSPECTION_REQUESTED", "REPAIR_IN_PROGRESS", "VERIFIED"]:
        if st not in by_status:
            by_status[st] = 0

    # By Priority
    cursor.execute(f"SELECT priority_level, COUNT(*) as cnt FROM hotspots{mode_clause} GROUP BY priority_level", tuple(params))
    by_priority = {row["priority_level"]: row["cnt"] for row in cursor.fetchall()}
    for pl in ["HIGH", "MEDIUM", "LOW"]:
        if pl not in by_priority:
            by_priority[pl] = 0

    # Top Corridors / Locations
    cursor.execute(
        f"SELECT location_name, COUNT(*) as count, AVG(priority_score) as avg_score "
        f"FROM hotspots{mode_clause} GROUP BY location_name ORDER BY count DESC, avg_score DESC LIMIT 8",
        tuple(params)
    )
    corridors = [
        {
            "name": row["location_name"] or "Unnamed Corridor",
            "count": row["count"],
            "avg_score": round(row["avg_score"], 1) if row["avg_score"] is not None else 0
        }
        for row in cursor.fetchall()
    ]

    # Average confidence & severity
    cursor.execute(f"SELECT AVG(avg_confidence), MAX(max_severity) FROM hotspots{mode_clause}", tuple(params))
    row_avg = cursor.fetchone()
    avg_confidence = round(row_avg[0], 3) if row_avg and row_avg[0] is not None else 0.0
    max_severity = round(row_avg[1], 2) if row_avg and row_avg[1] is not None else 0.0

    conn.close()

    return {
        "total_hotspots": total_hotspots,
        "total_raw_detections": total_raw_detections,
        "by_type": by_type,
        "by_status": by_status,
        "by_priority": by_priority,
        "corridors": corridors,
        "avg_confidence": avg_confidence,
        "max_severity": max_severity,
        "mode": mode_filter
    }

