"""
RoadGuard AI - Flask REST Backend & Telemetry Ingestion Server
=============================================================
Provides HTTP endpoints for ESP32 edge telemetry, streaming inference,
SQLite database transactions, device heartbeat monitoring, and the Leaflet dashboard.
"""

import os
import sys
import collections
import logging
import socket
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import numpy as np

def get_laptop_lan_ip() -> str:
    """Detects the primary LAN/Wi-Fi IPv4 address of this machine for ESP32 connectivity."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

# Add project root to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.database import (
    init_db,
    insert_raw_detection,
    get_all_hotspots,
    get_hotspot_by_id,
    update_hotspot_status,
    get_system_statistics,
    update_device_heartbeat,
    get_registered_devices,
    get_recent_raw_detections,
    get_analytics_summary,
    DEFAULT_DB_PATH
)
from backend.hotspots import process_and_aggregate_detection, validate_gps_coordinates
from ml.predict import get_predictor, RoadGuardPredictor

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("RoadGuardBackend")

app = Flask(
    __name__,
    static_folder=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dashboard", "static"))
)
CORS(app)

# In-memory rolling buffer per device (keeps last 200 samples)
DEVICE_BUFFERS = collections.defaultdict(lambda: collections.deque(maxlen=200))
LATEST_GPS = {}
DEVICE_LAST_SEQ = {}

# Initialize Database on app startup
init_db()

# Lazy/cached predictor
predictor = None
try:
    predictor = get_predictor()
    logger.info("[Flask] Successfully loaded RoadGuard Random Forest model.")
except Exception as e:
    logger.warning(f"[Flask Warning] Model not loaded at startup: {e}")


@app.route("/")
@app.route("/dashboard")
@app.route("/map")
@app.route("/alerts")
@app.route("/workflow")
@app.route("/fleet")
@app.route("/analytics")
def index():
    """Serves the main Pune Municipal Corporation RoadGuard Dashboard."""
    dashboard_html_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "dashboard", "index.html")
    )
    if os.path.exists(dashboard_html_path):
        with open(dashboard_html_path, "r", encoding="utf-8") as f:
            return f.read()
    return "Dashboard HTML not found. Please verify dashboard/index.html", 404


@app.route("/api/system-status", methods=["GET"])
def system_status():
    """Returns general backend health and active model metadata."""
    global predictor
    model_loaded = (predictor is not None and predictor.model is not None)
    metadata = predictor.metadata if model_loaded else {}

    return jsonify({
        "status": "online",
        "system_name": "RoadGuard AI Gateway Server",
        "timestamp": datetime.now().isoformat(),
        "model_loaded": model_loaded,
        "model_readiness": "MODEL_READY" if model_loaded else "MODEL_NOT_READY",
        "model_metadata": metadata,
        "database": DEFAULT_DB_PATH
    })


@app.route("/api/model-status", methods=["GET"])
def model_status():
    """Returns detailed status of the Machine Learning pipeline."""
    global predictor
    if predictor is None or predictor.model is None:
        return jsonify({
            "readiness": "MODEL_NOT_READY",
            "message": "Model not loaded. Train using: python ml/train_model.py",
            "classes": [],
            "features_count": 0
        })

    return jsonify({
        "readiness": "MODEL_READY",
        "model_type": predictor.metadata.get("model_type", "RandomForestClassifier"),
        "classes": predictor.classes_,
        "features_count": len(predictor.metadata.get("feature_names", [])),
        "confidence_threshold": predictor.confidence_threshold,
        "trained_on": predictor.metadata.get("created_at"),
        "metrics": predictor.metadata.get("metrics", {})
    })


@app.route("/api/device-status", methods=["GET"])
def device_status():
    """Returns connected ESP32 hardware units and their live connection/GPS status."""
    devices = get_registered_devices(offline_timeout_seconds=350.0)
    return jsonify({
        "count": len(devices),
        "devices": devices
    })


@app.route("/api/network-info", methods=["GET"])
def network_info():
    """Returns the host machine's LAN IP and recommended ESP32 endpoint URL."""
    lan_ip = get_laptop_lan_ip()
    port = int(os.environ.get("PORT", 5000))
    return jsonify({
        "laptop_lan_ip": lan_ip,
        "port": port,
        "backend_url": f"http://{lan_ip}:{port}/api/telemetry",
        "instructions": f"Set BACKEND_URL = \"http://{lan_ip}:{port}/api/telemetry\" in firmware/esp32_roadguard/secrets.h"
    })


@app.route("/api/hardware-position", methods=["GET"])
def hardware_position():
    """Returns the latest valid hardware GPS location, fix status, and staleness."""
    mode_filter = request.args.get("mode", "HARDWARE")
    devices = get_registered_devices(offline_timeout_seconds=350.0)

    # Filter by mode if specified (or default to HARDWARE)
    filtered = [d for d in devices if (mode_filter == "ALL" or d.get("mode", "HARDWARE") == mode_filter)]
    if not filtered:
        return jsonify({
            "connected": False,
            "status": "NO_HARDWARE_CONNECTED",
            "message": "No ESP32 hardware device is currently transmitting.",
            "position": None
        })

    # Prioritize online devices first
    online_devices = [d for d in filtered if d.get("status") == "ONLINE"]
    primary = online_devices[0] if online_devices else filtered[0]
    has_valid_fix = bool(primary.get("gps_fix")) and (primary.get("latitude") is not None) and (primary.get("longitude") is not None)

    return jsonify({
        "connected": primary.get("status") == "ONLINE",
        "device_id": primary.get("device_id"),
        "status": primary.get("status"),
        "gps_fix": bool(primary.get("gps_fix")),
        "fix_status": "3D_FIX" if has_valid_fix else "SEARCHING_FOR_SATELLITES",
        "satellites": primary.get("satellites", 0),
        "hdop": primary.get("hdop", 1.0),
        "accuracy_m": primary.get("estimated_accuracy_m", 5.0),
        "is_stale": bool(primary.get("is_stale", 0)),
        "seconds_since_seen": primary.get("seconds_since_seen"),
        "seconds_since_gps_fix": primary.get("seconds_since_gps_fix"),
        "mode": primary.get("mode", "HARDWARE"),
        "position": {
            "latitude": primary.get("latitude"),
            "longitude": primary.get("longitude"),
            "speed_kmh": primary.get("speed_kmh", 0.0),
            "last_fix_time": primary.get("last_gps_fix_at")
        } if (primary.get("latitude") is not None and primary.get("longitude") is not None) else None
    })


@app.route("/api/telemetry", methods=["POST"])
def ingest_telemetry():
    """
    Ingests sensor batch and GPS fix from ESP32 hardware or simulator.
    Validates payload format, sequence continuity, GPS freshness, and triggers ML inference.
    """
    global predictor

    # Payload size guard (max 1 MB)
    if request.content_length and request.content_length > 1024 * 1024:
        return jsonify({"error": "Payload exceeds 1 MB limit."}), 413

    data = request.get_json(silent=True)
    if not data or "samples" not in data or not isinstance(data["samples"], list):
        return jsonify({"error": "Invalid payload format. Expected 'samples' array."}), 400

    device_id = str(data.get("device_id", "ESP32_BUS_01")).strip()
    ride_id = str(data.get("ride_id", f"RIDE_{device_id}")).strip()
    mode = data.get("mode", "HARDWARE").upper()
    if mode not in ["HARDWARE", "SIMULATION"]:
        mode = "HARDWARE"

    seq_num = data.get("seq_num", 0)
    firmware_version = data.get("firmware_version", "1.0.0")

    # Sequence continuity check
    if device_id in DEVICE_LAST_SEQ:
        last_seq = DEVICE_LAST_SEQ[device_id]
        if seq_num > last_seq + 1:
            logger.warning(f"[{device_id}] Packet gap detected: missed sequences {last_seq+1} to {seq_num-1}")
    DEVICE_LAST_SEQ[device_id] = seq_num

    # GPS parsing and staleness check
    gps_data = data.get("gps", {})
    lat = gps_data.get("latitude")
    lon = gps_data.get("longitude")
    fix_valid = bool(gps_data.get("fix_valid", False))
    satellites = int(gps_data.get("satellites", 0))
    hdop = float(gps_data.get("hdop", 1.0))
    gps_timestamp_ms = gps_data.get("timestamp_ms")

    # Check GPS freshness (handles both Unix epoch timestamps and microcontroller uptime millis)
    is_stale = bool(gps_data.get("is_stale", False))
    current_time_ms = int(datetime.now().timestamp() * 1000)
    if gps_timestamp_ms:
        if gps_timestamp_ms > 1e11:  # Unix epoch timestamp (milliseconds)
            if (current_time_ms - gps_timestamp_ms) > 10000:
                is_stale = True
        else:
            # Microcontroller uptime millis: check explicit age if provided
            age_ms = gps_data.get("age_ms", 0)
            if age_ms > 10000:
                is_stale = True

    # Validate coordinate sanity
    gps_is_valid = validate_gps_coordinates(lat, lon, fix_valid=fix_valid, is_stale=is_stale)
    normalized_gps = {
        "latitude": float(lat) if (gps_is_valid and lat is not None) else None,
        "longitude": float(lon) if (gps_is_valid and lon is not None) else None,
        "valid": gps_is_valid,
        "satellites": satellites,
        "hdop": hdop,
        "is_stale": is_stale
    }
    LATEST_GPS[device_id] = normalized_gps

    # Update device heartbeat registry
    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr)
    update_device_heartbeat(
        device_id=device_id,
        ip_address=client_ip,
        gps_fix=gps_is_valid,
        satellites=satellites,
        hdop=hdop,
        seq_num=seq_num,
        firmware_version=firmware_version,
        latitude=normalized_gps["latitude"],
        longitude=normalized_gps["longitude"],
        speed_kmh=float(gps_data.get("speed_kmh", 0.0)),
        is_stale=is_stale,
        mode=mode
    )

    samples = data["samples"]
    buffer = DEVICE_BUFFERS[device_id]
    for s in samples:
        buffer.append(s)

    latest_prediction = None
    alert_triggered = False

    # Perform inference when buffer reaches >= 100 samples (1.0 sec window at 100Hz)
    if len(buffer) >= 100 and predictor is not None and predictor.model is not None:
        window_samples = list(buffer)[-100:]
        ax = np.array([s.get("ax", 0.0) for s in window_samples], dtype=np.float64)
        ay = np.array([s.get("ay", 0.0) for s in window_samples], dtype=np.float64)
        az = np.array([s.get("az", 1.0) for s in window_samples], dtype=np.float64)
        gx = np.array([s.get("gx", 0.0) for s in window_samples], dtype=np.float64)
        gy = np.array([s.get("gy", 0.0) for s in window_samples], dtype=np.float64)
        gz = np.array([s.get("gz", 0.0) for s in window_samples], dtype=np.float64)

        t_ms = window_samples[-1].get("t", current_time_ms)

        pred = predictor.predict_window(
            ax=ax, ay=ay, az=az, gx=gx, gy=gy, gz=gz,
            gps_fix=normalized_gps,
            timestamp_ms=t_ms
        )
        pred["device_id"] = device_id
        pred["ride_id"] = ride_id
        pred["mode"] = mode
        pred["seq_num"] = seq_num
        latest_prediction = pred

        # If eligible hazard detected (POTHOLE, SPEED_BREAKER, ROUGH_ROAD)
        if pred.get("is_hazard"):
            alert_triggered = (pred.get("class") == "POTHOLE")
            # 1. Insert into raw_detections table
            detection_id = insert_raw_detection(pred)
            # 2. Process spatial aggregation into hotspots (only if GPS is valid)
            hotspot_id = process_and_aggregate_detection(pred, detection_id)
            pred["hotspot_id"] = hotspot_id
            pred["location_status"] = "LOCATED" if hotspot_id else "UNLOCATED_NO_GPS"

    return jsonify({
        "status": "ok",
        "received_samples": len(samples),
        "buffer_size": len(buffer),
        "latest_prediction": latest_prediction,
        "alert": alert_triggered,
        "mode": mode
    })


@app.route("/api/hotspots", methods=["GET"])
def get_hotspots():
    """Returns aggregated road hazard hotspots with mode and status filters."""
    status_filter = request.args.get("status", "ALL")
    mode_filter = request.args.get("mode", "ALL")
    hotspots = get_all_hotspots(status_filter=status_filter, mode_filter=mode_filter)
    return jsonify({
        "count": len(hotspots),
        "mode": mode_filter,
        "status": status_filter,
        "hotspots": hotspots
    })


@app.route("/api/hotspots/<int:hotspot_id>/status", methods=["POST"])
def update_status(hotspot_id: int):
    """Updates repair workflow status for a specific hotspot."""
    body = request.get_json(silent=True) or {}
    new_status = body.get("status")
    notes = body.get("notes", "")
    updated_by = body.get("updated_by", "PMC Road Engineer")

    if not new_status:
        return jsonify({"error": "Missing 'status' in request body."}), 400

    try:
        success = update_hotspot_status(
            hotspot_id=hotspot_id,
            new_status=new_status,
            updated_by=updated_by,
            notes=notes
        )
        if not success:
            return jsonify({"error": f"Hotspot with ID {hotspot_id} not found."}), 404
        return jsonify({"status": "success", "message": f"Updated hotspot {hotspot_id} to {new_status}"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/stats", methods=["GET"])
def get_stats():
    """Returns summary KPIs for the municipal dashboard with mode filtering."""
    mode_filter = request.args.get("mode", "ALL")
    stats = get_system_statistics(mode_filter=mode_filter)
    return jsonify(stats)


@app.route("/api/detections", methods=["GET"])
def get_detections():
    """Returns recent raw sensor hazard detections with GPS telemetry and mode filtering."""
    limit = int(request.args.get("limit", 50))
    mode_filter = request.args.get("mode", "ALL")
    hazard_type = request.args.get("type", "ALL")
    detections = get_recent_raw_detections(limit=limit, mode_filter=mode_filter, hazard_type=hazard_type)
    return jsonify({
        "count": len(detections),
        "mode": mode_filter,
        "type": hazard_type,
        "detections": detections
    })


@app.route("/api/analytics", methods=["GET"])
def get_analytics():
    """Returns aggregated hazard, status, priority, and corridor analytics for charts."""
    mode_filter = request.args.get("mode", "ALL")
    summary = get_analytics_summary(mode_filter=mode_filter)
    return jsonify(summary)



@app.route("/api/demo/seed", methods=["POST"])
def seed_demo_data():
    """
    Populates initial representative Pune road hazard hotspots matching the hackathon slide deck.
    Explicitly labeled as SIMULATION mode.
    """
    from backend.database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()

    demo_hotspots = [
        ("POTHOLE", 18.5204, 73.8567, "FC Road, Deccan, Pune", 36, 5, 0.94, 3.65, 88, "HIGH", "DETECTED"),
        ("POTHOLE", 18.5074, 73.8077, "Kothrud - Paud Road", 28, 4, 0.91, 3.20, 82, "HIGH", "INSPECTION_REQUESTED"),
        ("ROUGH_ROAD", 18.5913, 73.7389, "Hinjewadi Phase 1 IT Corridor", 18, 3, 0.88, 2.10, 58, "MEDIUM", "REPAIR_IN_PROGRESS"),
        ("POTHOLE", 18.5089, 73.9260, "Hadapsar - Magarpatta Road", 16, 2, 0.85, 2.80, 52, "MEDIUM", "DETECTED"),
        ("SPEED_BREAKER", 18.5314, 73.8446, "Shivajinagar Station Road", 14, 3, 0.96, 2.05, 38, "LOW", "DETECTED"),
        ("POTHOLE", 18.5679, 73.9143, "Viman Nagar - Airport Road", 22, 4, 0.89, 3.10, 76, "HIGH", "VERIFIED"),
        ("ROUGH_ROAD", 18.5018, 73.8586, "Swargate Bus Terminal Corridor", 12, 2, 0.82, 1.95, 46, "MEDIUM", "DETECTED")
    ]

    now_iso = datetime.now().isoformat()
    for h in demo_hotspots:
        cursor.execute("""
            INSERT INTO hotspots (
                hazard_type, latitude, longitude, location_name,
                observation_count, distinct_rides, avg_confidence, max_severity,
                priority_score, priority_level, status, first_detected_at, last_detected_at, notes, mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIMULATION')
        """, (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8], h[9], h[10], now_iso, now_iso, "Demonstration hotspot calibrated with research waveform profile"))

    conn.commit()
    conn.close()
    return jsonify({"status": "seeded", "message": f"Added {len(demo_hotspots)} representative Pune demo hotspots (Mode: SIMULATION)."})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    host = os.environ.get("HOST", "0.0.0.0")
    lan_ip = get_laptop_lan_ip()
    print(f"\n=======================================================")
    print(f"  RoadGuard AI Telemetry Gateway Running!")
    print(f"  Laptop LAN IPv4 Address: {lan_ip}")
    print(f"  ESP32 BACKEND_URL:      http://{lan_ip}:{port}/api/telemetry")
    print(f"  Dashboard (Local):      http://localhost:{port}/")
    print(f"  Network Info Endpoint:  http://localhost:{port}/api/network-info")
    print(f"=======================================================\n")
    app.run(host="0.0.0.0", port=5000, debug=True)
