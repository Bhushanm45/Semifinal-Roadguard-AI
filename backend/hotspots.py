"""
RoadGuard AI - Hotspot Aggregation & Inspection Priority Engine
===============================================================
Groups repeated hazard reports into consolidated geographical hotspots
and computes an objective inspection priority score.

Methodological Principles:
--------------------------
1. Spatial Clustering:
   - Uses the Haversine great-circle distance formula to identify detections within a
     configurable radius (default: 25 meters) belonging to the same hazard class and mode.
2. Independent Confirmation (Anti-Duplicate Guard):
   - Multiple detections from the SAME vehicle pass (e.g. front and rear axles hitting
     the same pothole within seconds) are NOT counted as independent confirmations.
   - Only detections from distinct `ride_id` sessions increment `distinct_rides`.
3. Strict Real GPS Quality Validation:
   - Coordinates of (0.0, 0.0) ("Null Island"), invalid ranges, or unacquired fixes are rejected.
   - Stale GPS readings (>10 seconds older than sensor window) are rejected from map clustering.
4. Mode Partitioning:
   - Real HARDWARE detections and SIMULATION demo runs are strictly segregated.
"""

import math
from datetime import datetime
from typing import Dict, Any, Optional, Tuple, List

from backend.database import (
    get_db_connection,
    link_detection_to_hotspot,
    DEFAULT_DB_PATH
)

CLUSTER_RADIUS_METERS = 25.0  # GPS cluster threshold


def haversine_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Computes great-circle distance between two GPS coordinates in meters.
    Formula:
      a = sin²(Δφ/2) + cos(φ1) * cos(φ2) * sin²(Δλ/2)
      c = 2 * atan2(√a, √(1−a))
      d = R * c
    """
    R = 6371000.0  # Earth's radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


def validate_gps_coordinates(lat: Optional[float], lon: Optional[float], fix_valid: bool = True, is_stale: bool = False) -> bool:
    """
    Validates physical GPS fix.
    Rejects Null Island (0,0), out-of-range degrees, invalid fixes, and stale data.
    """
    if not fix_valid or is_stale:
        return False
    if lat is None or lon is None:
        return False
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (ValueError, TypeError):
        return False

    # Check bounds
    if not (-90.0 <= lat_f <= 90.0) or not (-180.0 <= lon_f <= 180.0):
        return False

    # Check Null Island (0.0, 0.0) - classical boot/no-fix output
    if abs(lat_f) < 1e-4 and abs(lon_f) < 1e-4:
        return False

    return True


def determine_pune_location_name(lat: float, lon: float) -> str:
    """Assigns nearest Pune transit landmark based on coordinates for UI clarity."""
    landmarks = [
        ("FC Road, Deccan", 18.5204, 73.8436),
        ("Kothrud - Paud Road", 18.5074, 73.8077),
        ("Hinjewadi Phase 1", 18.5913, 73.7389),
        ("Hadapsar - Magarpatta", 18.5089, 73.9260),
        ("Shivajinagar Station", 18.5314, 73.8446),
        ("Viman Nagar Bypass", 18.5679, 73.9143),
        ("Swargate Junction", 18.5018, 73.8586)
    ]
    closest_name = "Pune Municipal Ward"
    min_dist = float("inf")
    for name, l_lat, l_lon in landmarks:
        d = haversine_distance_meters(lat, lon, l_lat, l_lon)
        if d < min_dist:
            min_dist = d
            closest_name = name
    if min_dist > 4000:
        return f"Geotagged Obstacle ({lat:.4f}, {lon:.4f})"
    return closest_name


def calculate_priority_score(
    distinct_rides: int,
    avg_confidence: float,
    max_severity: float,
    last_detected_iso: str
) -> Tuple[int, str]:
    """Computes priority score (0-100) and maps to HIGH, MEDIUM, or LOW tier."""
    s_rides = min(45.0, distinct_rides * 15.0)
    s_conf = max(0.0, min(20.0, avg_confidence * 20.0))
    delta_g = max(0.0, max_severity - 1.0)
    s_severity = min(20.0, delta_g * 7.0)

    try:
        last_dt = datetime.fromisoformat(last_detected_iso)
        age_days = (datetime.now() - last_dt).total_seconds() / 86400.0
        s_recency = 15.0 * math.exp(-max(0.0, age_days) / 7.0)
    except Exception:
        s_recency = 15.0

    raw_score = s_rides + s_conf + s_severity + s_recency
    score = int(round(max(5.0, min(100.0, raw_score))))

    if score >= 70:
        level = "HIGH"
    elif score >= 40:
        level = "MEDIUM"
    else:
        level = "LOW"

    return score, level


def process_and_aggregate_detection(
    detection: Dict[str, Any],
    detection_id: int,
    db_path: str = DEFAULT_DB_PATH
) -> Optional[int]:
    """
    Aggregates a newly classified hazard detection into existing or new hotspot.
    Enforces strict GPS validation and mode isolation.
    Returns parent hotspot_id, or None if GPS is invalid or unlocated.
    """
    hazard_type = detection.get("class")
    if not hazard_type or hazard_type not in ["POTHOLE", "SPEED_BREAKER", "ROUGH_ROAD"]:
        return None

    gps = detection.get("gps", {})
    lat = gps.get("latitude")
    lon = gps.get("longitude")
    fix_valid = bool(gps.get("valid", True))
    is_stale = bool(gps.get("is_stale", False))

    if not validate_gps_coordinates(lat, lon, fix_valid=fix_valid, is_stale=is_stale):
        # Without valid, fresh GPS, detection is recorded as raw telemetry but NOT mapped as confirmed hotspot
        return None

    lat = float(lat)
    lon = float(lon)
    confidence = float(detection.get("confidence", 0.8))
    severity = float(detection.get("severity_metric", 1.5))
    ride_id = detection.get("ride_id", "UNKNOWN_RIDE")
    mode = detection.get("mode", "HARDWARE")
    now_iso = datetime.now().isoformat()

    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # Query existing active hotspots with same hazard type AND same mode
    cursor.execute("""
        SELECT * FROM hotspots
        WHERE hazard_type = ? AND mode = ? AND status != 'VERIFIED'
    """, (hazard_type, mode))
    candidates = cursor.fetchall()

    matched_hotspot = None
    min_dist = float("inf")

    for h in candidates:
        dist = haversine_distance_meters(lat, lon, h["latitude"], h["longitude"])
        if dist <= CLUSTER_RADIUS_METERS and dist < min_dist:
            min_dist = dist
            matched_hotspot = h

    if matched_hotspot:
        hotspot_id = matched_hotspot["id"]
        old_count = matched_hotspot["observation_count"]
        new_count = old_count + 1

        # Check if this ride has already been recorded for this hotspot
        cursor.execute("""
            SELECT COUNT(*) FROM raw_detections
            WHERE hotspot_id = ? AND ride_id = ?
        """, (hotspot_id, ride_id))
        prior_reports_same_ride = cursor.fetchone()[0]

        is_new_ride = (prior_reports_same_ride == 0)
        new_distinct_rides = matched_hotspot["distinct_rides"] + (1 if is_new_ride else 0)

        # Update centroid position (weighted average)
        new_lat = ((matched_hotspot["latitude"] * old_count) + lat) / new_count
        new_lon = ((matched_hotspot["longitude"] * old_count) + lon) / new_count

        # Running average confidence
        new_avg_conf = ((matched_hotspot["avg_confidence"] * old_count) + confidence) / new_count
        new_max_severity = max(matched_hotspot["max_severity"], severity)

        # Recalculate priority
        new_score, new_level = calculate_priority_score(
            distinct_rides=new_distinct_rides,
            avg_confidence=new_avg_conf,
            max_severity=new_max_severity,
            last_detected_iso=now_iso
        )

        cursor.execute("""
            UPDATE hotspots SET
                latitude = ?,
                longitude = ?,
                observation_count = ?,
                distinct_rides = ?,
                avg_confidence = ?,
                max_severity = ?,
                priority_score = ?,
                priority_level = ?,
                last_detected_at = ?
            WHERE id = ?
        """, (
            round(new_lat, 6),
            round(new_lon, 6),
            new_count,
            new_distinct_rides,
            round(new_avg_conf, 4),
            round(new_max_severity, 3),
            new_score,
            new_level,
            now_iso,
            hotspot_id
        ))

    else:
        # Create brand new hotspot
        location_name = determine_pune_location_name(lat, lon)
        score, level = calculate_priority_score(
            distinct_rides=1,
            avg_confidence=confidence,
            max_severity=severity,
            last_detected_iso=now_iso
        )

        cursor.execute("""
            INSERT INTO hotspots (
                hazard_type, latitude, longitude, location_name,
                observation_count, distinct_rides, avg_confidence, max_severity,
                priority_score, priority_level, status, first_detected_at, last_detected_at, mode
            ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 'DETECTED', ?, ?, ?)
        """, (
            hazard_type,
            round(lat, 6),
            round(lon, 6),
            location_name,
            round(confidence, 4),
            round(severity, 3),
            score,
            level,
            now_iso,
            now_iso,
            mode
        ))
        hotspot_id = cursor.lastrowid

    conn.commit()
    conn.close()

    # Link raw detection row to the parent hotspot
    link_detection_to_hotspot(detection_id, hotspot_id, db_path=db_path)
    return hotspot_id
