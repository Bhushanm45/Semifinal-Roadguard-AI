/**
 * RoadGuard AI - Pune Municipal Corporation Dashboard Script
 * ==========================================================
 * Handles:
 * 1. Single-page client-side routing & deep-linking for all 6 sidebar sections
 * 2. Leaflet GIS map with OpenStreetMap tiles & browser "Locate Me" navigation
 * 3. Real-time hardware telemetry and device heartbeat polling
 * 4. Hazard alerts table with filtering and raw sensor packet stream inspection
 * 5. Interactive 4-stage municipal repair workflow (Kanban board)
 * 6. PMPML bus fleet status monitoring and hardware connection guide
 * 7. Chart.js analytics trends and KPI aggregations
 */

// Application State
let map = null;
let markersLayer = null;
let userLocationLayer = null;
let hardwareLocationLayer = null;
let hardwareLocationMarker = null;
let latestHardwareDevice = null;
let hasAutoCenteredHardware = false;

let activeHotspots = [];
let rawDetections = [];
let pollingInterval = null;
let devicePollingInterval = null;
let currentMode = "HARDWARE"; // Default to real hardware view
let activeSection = "dashboard";
let alertsViewMode = "HOTSPOTS"; // "HOTSPOTS" or "RAW"
let chartInstances = {};

// Routing Map
const ROUTES = {
    "": "dashboard",
    "/": "dashboard",
    "/dashboard": "dashboard",
    "/map": "map",
    "/alerts": "alerts",
    "/workflow": "workflow",
    "/fleet": "fleet",
    "/analytics": "analytics"
};

document.addEventListener("DOMContentLoaded", () => {
    initNavigationRouter();
    initMap();
    initEventListeners();
    fetchModelStatus();
    fetchDeviceStatus();
    fetchNetworkInfo();
    refreshDashboard();

    // Fast polling for device connection heartbeat (every 2s)
    devicePollingInterval = setInterval(fetchDeviceStatus, 2000);

    // Refresh network info every 30s (IP can change when hotspot reconnects)
    setInterval(fetchNetworkInfo, 30000);

    // Main polling for hotspots and KPI metrics (every 3s)
    pollingInterval = setInterval(refreshDashboard, 3000);
});

/**
 * -------------------------------------------------------------
 * 1. Single-Page Routing & Deep Linking
 * -------------------------------------------------------------
 */
function initNavigationRouter() {
    // 1. Attach click handlers to all sidebar items
    const navItems = document.querySelectorAll(".nav-menu .nav-item");
    navItems.forEach(item => {
        item.addEventListener("click", () => {
            const section = item.getAttribute("data-section");
            if (section) {
                navigateTo(section, true);
            }
        });
    });

    // 2. Handle browser Back/Forward buttons
    window.addEventListener("popstate", (e) => {
        const path = window.location.pathname.toLowerCase().replace(/\/$/, "") || "/";
        const section = ROUTES[path] || "dashboard";
        navigateTo(section, false);
    });

    // 3. Resolve initial route from URL bar
    const currentPath = window.location.pathname.toLowerCase().replace(/\/$/, "") || "/";
    const initialSection = ROUTES[currentPath] || "dashboard";
    navigateTo(initialSection, false);
}

function navigateTo(section, pushState = true) {
    if (!section) section = "dashboard";
    activeSection = section;

    // 1. Update URL bar
    if (pushState) {
        const targetUrl = section === "dashboard" ? "/" : `/${section}`;
        if (window.location.pathname !== targetUrl) {
            window.history.pushState({ section }, "", targetUrl);
        }
    }

    // 2. Update Sidebar Active Class
    document.querySelectorAll(".nav-menu .nav-item").forEach(item => {
        const itemSec = item.getAttribute("data-section");
        if (itemSec === section) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });

    // 3. Toggle View Containers
    document.querySelectorAll(".page-view").forEach(view => {
        view.classList.remove("active");
    });
    const targetView = document.getElementById(`view-${section}`);
    if (targetView) {
        targetView.classList.add("active");
    }

    // 4. Section-specific activation callbacks
    if (section === "map") {
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
            }
        }, 120);
    } else if (section === "alerts") {
        renderAlertsPage();
    } else if (section === "workflow") {
        renderWorkflowBoard();
    } else if (section === "fleet") {
        renderFleetPage();
    } else if (section === "analytics") {
        renderAnalyticsPage();
    }
}

/**
 * -------------------------------------------------------------
 * 2. Leaflet Map Initialization with OpenStreetMap Tiles
 * -------------------------------------------------------------
 */
function initMap() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    // Center on Pune City: 18.5204 N, 73.8567 E
    map = L.map("map", {
        center: [18.5204, 73.8567],
        zoom: 12.5,
        zoomControl: true
    });

    // Using OpenStreetMap Standard tiles (Fixes CARTO "API KEY REQUIRED" watermark completely)
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);
    userLocationLayer = L.layerGroup().addTo(map);
    hardwareLocationLayer = L.layerGroup().addTo(map);
}

/**
 * Recenter Map to Pune Central Coordinates
 */
function recenterPuneMap() {
    if (map) {
        map.flyTo([18.5204, 73.8567], 12.5, { duration: 1.0 });
    }
}

/**
 * Center Map on Physical ESP32 Hardware GPS Location
 */
function centerOnHardwareGps() {
    if (!latestHardwareDevice) {
        alert("No physical ESP32 hardware device is connected yet. Waiting for telemetry packets at /api/telemetry.");
        return;
    }

    if (latestHardwareDevice.latitude === null || latestHardwareDevice.longitude === null) {
        alert("ESP32 hardware is connected, but the NEO-6M GPS receiver is still searching for satellites. Take the antenna outdoors or near an open window to acquire 3D satellite lock.");
        return;
    }

    const lat = Number(latestHardwareDevice.latitude);
    const lon = Number(latestHardwareDevice.longitude);
    if (map) {
        map.flyTo([lat, lon], 15, { duration: 1.0 });
        if (hardwareLocationMarker) {
            hardwareLocationMarker.openPopup();
        }
    }
}

/**
 * -------------------------------------------------------------
 * 3. Event Listeners Initialization
 * -------------------------------------------------------------
 */
function initEventListeners() {
    // Mode Switcher (Hardware vs Simulation vs All)
    const modeSelect = document.getElementById("systemModeSelect");
    if (modeSelect) {
        modeSelect.addEventListener("change", (e) => {
            currentMode = e.target.value;
            const badge = document.getElementById("activeModeBadge");
            if (currentMode === "HARDWARE") {
                badge.innerHTML = '<i class="fa-solid fa-microchip"></i> Showing: Real Hardware Telemetry';
                badge.style.color = "#34D399";
                badge.style.borderColor = "rgba(52, 211, 153, 0.4)";
            } else if (currentMode === "SIMULATION") {
                badge.innerHTML = '<i class="fa-solid fa-flask"></i> Showing: Synthetic Simulation Demo';
                badge.style.color = "#FBBF24";
                badge.style.borderColor = "rgba(251, 191, 36, 0.4)";
            } else {
                badge.innerHTML = '<i class="fa-solid fa-layer-group"></i> Showing: All Data Sources';
                badge.style.color = "#38BDF8";
                badge.style.borderColor = "rgba(56, 189, 248, 0.3)";
            }
            refreshDashboard();
            fetchDeviceStatus();
            if (activeSection === "analytics") renderAnalyticsPage();
            if (activeSection === "alerts") renderAlertsPage();
            if (activeSection === "workflow") renderWorkflowBoard();
        });
    }

    // Map Hazard Type Filter
    const typeFilter = document.getElementById("typeFilter");
    if (typeFilter) {
        typeFilter.addEventListener("change", () => {
            renderMarkers();
            renderHotspotsTable();
        });
    }

    // Map Repair Status Filter
    const statusFilter = document.getElementById("statusFilter");
    if (statusFilter) {
        statusFilter.addEventListener("change", () => {
            renderMarkers();
            renderHotspotsTable();
        });
    }

    // Center on Hardware GPS Location
    const btnCenterHw = document.getElementById("btnCenterHardwareGps");
    if (btnCenterHw) {
        btnCenterHw.addEventListener("click", centerOnHardwareGps);
    }

    // Locate Me (Browser Geolocation - Strictly Separated from Hardware GPS)
    const btnLocate = document.getElementById("btnLocateMe");
    if (btnLocate) {
        btnLocate.addEventListener("click", handleBrowserLocateMe);
    }

    // Recenter Pune
    const btnRecenter = document.getElementById("btnRecenterPune");
    if (btnRecenter) {
        btnRecenter.addEventListener("click", recenterPuneMap);
    }

    // Test Ping Hardware Link Trigger
    const btnTestPing = document.getElementById("btnTestHwPing");
    if (btnTestPing) {
        btnTestPing.addEventListener("click", handleTestPingLink);
    }

    // Simulation Trigger
    const btnSim = document.getElementById("btnRunSim");
    if (btnSim) {
        btnSim.addEventListener("click", triggerLiveSimulation);
    }

    // Seed Hotspots
    const btnSeed = document.getElementById("btnSeedDemo");
    if (btnSeed) {
        btnSeed.addEventListener("click", seedPuneDemoHotspots);
    }

    // Alerts view controls
    const searchInput = document.getElementById("alertsSearchInput");
    if (searchInput) {
        searchInput.addEventListener("input", renderAlertsPage);
    }
    const aType = document.getElementById("alertsTypeFilter");
    if (aType) aType.addEventListener("change", renderAlertsPage);
    const aPrio = document.getElementById("alertsPriorityFilter");
    if (aPrio) aPrio.addEventListener("change", renderAlertsPage);
    const aStat = document.getElementById("alertsStatusFilter");
    if (aStat) aStat.addEventListener("change", renderAlertsPage);
    const btnRefAlerts = document.getElementById("btnRefreshAlerts");
    if (btnRefAlerts) btnRefAlerts.addEventListener("click", renderAlertsPage);

    // Source toggle in alerts
    const btnToggleHotspots = document.getElementById("toggleHotspots");
    const btnToggleRaw = document.getElementById("toggleRawDetections");
    if (btnToggleHotspots && btnToggleRaw) {
        btnToggleHotspots.addEventListener("click", () => {
            alertsViewMode = "HOTSPOTS";
            btnToggleHotspots.classList.add("active");
            btnToggleRaw.classList.remove("active");
            renderAlertsPage();
        });
        btnToggleRaw.addEventListener("click", () => {
            alertsViewMode = "RAW";
            btnToggleRaw.classList.add("active");
            btnToggleHotspots.classList.remove("active");
            renderAlertsPage();
        });
    }
}

/**
 * -------------------------------------------------------------
 * 4. Browser Geolocation ("Locate Me")
 * -------------------------------------------------------------
 * Strictly separated from physical vehicle GPS. Used only for
 * centering the map on the user's laptop/phone view.
 */
function handleBrowserLocateMe() {
    if (!navigator.geolocation) {
        alert("Browser geolocation is not supported by your browser.");
        return;
    }

    const btn = document.getElementById("btnLocateMe");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Locating...';
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const userLat = position.coords.latitude;
            const userLon = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            if (userLocationLayer) userLocationLayer.clearLayers();

            const userIcon = L.divIcon({
                className: "user-location-icon",
                html: '<div class="user-location-marker"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            });

            const marker = L.marker([userLat, userLon], { icon: userIcon });
            marker.bindPopup(`
                <div style="font-family:Inter,sans-serif; font-size:12px;">
                    <strong>Laptop / Phone Browser Location</strong><br>
                    📍 ${userLat.toFixed(5)}, ${userLon.toFixed(5)}<br>
                    <span style="color:#64748B; font-size:11px;">Accuracy: ±${Math.round(accuracy)}m</span><br>
                    <em style="color:#0284C7; font-size:10px;">(Used for local view navigation only; NOT vehicle GPS)</em>
                </div>
            `);
            if (userLocationLayer) {
                userLocationLayer.addLayer(marker);

                const circle = L.circle([userLat, userLon], {
                    radius: Math.max(accuracy, 25),
                    color: "#3B82F6",
                    fillColor: "#3B82F6",
                    fillOpacity: 0.15,
                    weight: 1
                });
                userLocationLayer.addLayer(circle);
            }

            if (map) {
                map.flyTo([userLat, userLon], 14, { duration: 1.2 });
                marker.openPopup();
            }

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-laptop"></i> Located';
                setTimeout(() => {
                    btn.innerHTML = '<i class="fa-solid fa-laptop"></i> Browser Location';
                }, 3000);
            }
        },
        (error) => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-laptop"></i> Browser Location';
            }
            let msg = "Could not obtain browser location.";
            if (error.code === error.PERMISSION_DENIED) {
                msg = "Browser location permission was denied. (Note: Vehicle detection relies on ESP32 physical GPS, not browser location).";
            } else if (error.code === error.POSITION_UNAVAILABLE) {
                msg = "Browser location information is currently unavailable.";
            } else if (error.code === error.TIMEOUT) {
                msg = "Browser location request timed out.";
            }
            alert(msg);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );
}

/**
 * Triggers an immediate hardware heartbeat packet to verify the website connection & green dot.
 */
async function handleTestPingLink() {
    const btn = document.getElementById("btnTestHwPing");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Pinging...';
    }

    try {
        const payload = {
            device_id: "ESP32_BUS_01",
            mode: "HARDWARE",
            seq_num: Math.floor(Date.now() / 1000) % 100000,
            firmware_version: "1.3.1",
            gps: {
                latitude: null,
                longitude: null,
                speed_kmh: 0.0,
                fix_valid: false,
                satellites: 0,
                hdop: 99.0,
                timestamp_ms: Date.now()
            },
            edge_event: {
                impact_detected: false,
                max_shock_g: 0.0
            },
            samples: Array.from({ length: 20 }, (_, i) => ({
                t: Date.now() + i * 10,
                ax: 0.01,
                ay: -0.01,
                az: 1.0,
                gx: 0.0,
                gy: 0.0,
                gz: 0.0
            }))
        };

        const res = await fetch("/api/telemetry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            await fetchDeviceStatus();
        }
    } catch (e) {
        console.error("Test ping failed:", e);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Ping Test Link';
        }
    }
}

/**
 * -------------------------------------------------------------
 * 5. Device Heartbeat & Hardware GPS Marker Polling
 * -------------------------------------------------------------
 */
async function fetchDeviceStatus() {
    try {
        const res = await fetch("/api/device-status");
        if (res.ok) {
            const data = await res.json();
            const devices = data.devices || [];

            const devDot = document.getElementById("hwDeviceDot");
            const devText = document.getElementById("hwDeviceText");
            const gpsText = document.getElementById("hwGpsText");
            const telText = document.getElementById("hwLastTelemetryText");
            const mapBanner = document.getElementById("hwGpsMapBanner");
            const mapBannerText = document.getElementById("hwGpsBannerText");

            // Filter for primary hardware device matching mode if possible
            let relevantDevices = devices;
            if (currentMode === "HARDWARE") {
                relevantDevices = devices.filter(d => d.mode !== "SIMULATION");
            } else if (currentMode === "SIMULATION") {
                relevantDevices = devices.filter(d => d.mode === "SIMULATION");
            }

            if (relevantDevices.length > 0) {
                // Prioritize an actively transmitting ONLINE device, then physical hardware unit ESP32_BUS_01
                const activeOnline = relevantDevices.find(d => d.status === "ONLINE");
                const busUnit = relevantDevices.find(d => d.device_id === "ESP32_BUS_01");
                const latest = activeOnline || busUnit || relevantDevices[0];
                latestHardwareDevice = latest;

                if (latest.status === "ONLINE") {
                    if (devDot) devDot.className = "hw-indicator dot-online";
                    if (devText) devText.innerHTML = `<strong>${latest.device_id}</strong> <span style="color:#10B981;">(Online • ${latest.ip_address || "LAN"})</span>`;
                    if (telText) telText.textContent = `${latest.seconds_since_seen}s ago (Seq #${latest.last_seq_num || 0})`;

                    const hasGpsCoords = (latest.latitude !== null && latest.longitude !== null);

                    if (latest.gps_fix && hasGpsCoords) {
                        if (gpsText) {
                            gpsText.innerHTML = `<span style="color:#10B981;"><i class="fa-solid fa-satellite"></i> 3D Fix (${latest.satellites} Sats • HDOP ${latest.hdop})</span>`;
                        }
                        if (mapBanner) mapBanner.classList.remove("visible");
                        updateHardwareMapMarker(latest, false);
                    } else {
                        // Searching for satellites / invalid fix
                        if (gpsText) {
                            gpsText.innerHTML = `<span style="color:#F59E0B;"><i class="fa-solid fa-satellite-dish fa-spin"></i> Searching (${latest.satellites || 0} Sats in view)</span>`;
                        }
                        if (mapBanner) {
                            mapBanner.classList.add("visible");
                            if (mapBannerText) {
                                mapBannerText.innerHTML = `Waiting for physical ESP32 GPS fix... (NEO-6M searching: ${latest.satellites || 0} satellites visible, HDOP ${latest.hdop || 1.0})`;
                            }
                        }
                        // If a previous known fix exists, show as stale
                        if (hasGpsCoords) {
                            updateHardwareMapMarker(latest, true);
                        } else {
                            if (hardwareLocationMarker && hardwareLocationLayer) {
                                hardwareLocationLayer.clearLayers();
                                hardwareLocationMarker = null;
                            }
                        }
                    }
                } else {
                    // Device is OFFLINE
                    if (devDot) devDot.className = "hw-indicator dot-offline";
                    if (devText) devText.innerHTML = `<strong>${latest.device_id}</strong> (Offline • last seen ${latest.seconds_since_seen}s ago)`;
                    if (gpsText) gpsText.innerHTML = '<span style="color:#94A3B8;">GPS Inactive (Offline)</span>';
                    if (telText) telText.textContent = `Offline (${latest.seconds_since_seen}s ago)`;

                    if (mapBanner) {
                        mapBanner.classList.add("visible");
                        if (mapBannerText) {
                            mapBannerText.innerHTML = `ESP32 Hardware Disconnected (${latest.device_id} is offline. Last seen ${latest.seconds_since_seen}s ago)`;
                        }
                    }
                    if (latest.latitude !== null && latest.longitude !== null) {
                        updateHardwareMapMarker(latest, true);
                    } else if (hardwareLocationMarker && hardwareLocationLayer) {
                        hardwareLocationLayer.clearLayers();
                        hardwareLocationMarker = null;
                    }
                }
            } else {
                latestHardwareDevice = null;
                if (devDot) devDot.className = "hw-indicator dot-offline";
                if (devText) devText.textContent = currentMode === "HARDWARE" 
                    ? "No ESP32 connected (Waiting for /api/telemetry)" 
                    : "No simulator connected";
                if (gpsText) gpsText.innerHTML = '<span style="color:#94A3B8;">GPS Inactive</span>';
                if (telText) telText.textContent = "Waiting for packets...";

                if (mapBanner) {
                    mapBanner.classList.add("visible");
                    if (mapBannerText) {
                        mapBannerText.innerHTML = `No physical ESP32 transmitting. Connect hardware to stream real NEO-6M GPS coordinates.`;
                    }
                }
                if (hardwareLocationMarker && hardwareLocationLayer) {
                    hardwareLocationLayer.clearLayers();
                    hardwareLocationMarker = null;
                }
            }
        }
    } catch (e) {
        const devText = document.getElementById("hwDeviceText");
        if (devText) devText.textContent = "Backend Connection Error";
    }
}

/**
 * Updates the distinct vehicle hardware GPS marker on the map
 */
function updateHardwareMapMarker(deviceData, isStale = false) {
    if (!map || !hardwareLocationLayer) return;
    if (deviceData.latitude === null || deviceData.longitude === null) return;

    const lat = Number(deviceData.latitude);
    const lon = Number(deviceData.longitude);
    if (isNaN(lat) || isNaN(lon) || (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001)) {
        return; // Strictly reject (0, 0) Null Island
    }

    const actuallyStale = isStale || deviceData.is_stale || (deviceData.status === "OFFLINE");
    const markerClass = actuallyStale ? "hw-vehicle-marker hw-vehicle-stale" : "hw-vehicle-marker";

    const customIcon = L.divIcon({
        className: markerClass,
        html: `
            <div class="hw-vehicle-pulse"></div>
            <div class="hw-vehicle-body">
                <i class="fa-solid fa-bus"></i>
            </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
    });

    const statusBadge = actuallyStale
        ? '<span style="background:rgba(245,158,11,0.25); color:#F59E0B; padding:2px 6px; border-radius:3px; font-weight:700; font-size:10px;">STALE (LAST KNOWN FIX)</span>'
        : '<span style="background:rgba(16,185,129,0.25); color:#10B981; padding:2px 6px; border-radius:3px; font-weight:700; font-size:10px;">LIVE 3D GPS FIX</span>';

    const originModeTag = (deviceData.mode === "HARDWARE")
        ? '<span style="color:#34D399; font-weight:700; font-size:10px;">REAL HARDWARE</span>'
        : '<span style="color:#FBBF24; font-weight:700; font-size:10px;">SIMULATED TELEMETRY</span>';

    const popupHtml = `
        <div style="font-family:Inter,sans-serif; min-width:230px;">
            <div style="font-weight:700; font-size:13px; color:#0F172A; display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span><i class="fa-solid fa-bus"></i> ${deviceData.device_id}</span>
                ${statusBadge}
            </div>
            <div style="font-size:11px; color:#475569; margin-bottom:6px;">
                📍 ${lat.toFixed(6)}, ${lon.toFixed(6)} [${originModeTag}]
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; font-size:11px; margin-bottom:6px;">
                <div><strong>Satellites:</strong> ${deviceData.satellites || 0}</div>
                <div><strong>HDOP:</strong> ${deviceData.hdop || 1.0}</div>
                <div><strong>Accuracy:</strong> ±${deviceData.estimated_accuracy_m || 5.0}m</div>
                <div><strong>Speed:</strong> ${deviceData.speed_kmh || 0.0} km/h</div>
            </div>
            <div style="font-size:10px; color:#64748B; border-top:1px solid #CBD5E1; padding-top:4px;">
                <em>Physical GPS Source • Last updated ${deviceData.seconds_since_seen || 0}s ago</em>
            </div>
        </div>
    `;

    if (hardwareLocationMarker) {
        hardwareLocationMarker.setLatLng([lat, lon]);
        hardwareLocationMarker.setIcon(customIcon);
        hardwareLocationMarker.setPopupContent(popupHtml);
    } else {
        hardwareLocationMarker = L.marker([lat, lon], { icon: customIcon, zIndexOffset: 1000 });
        hardwareLocationMarker.bindPopup(popupHtml);
        hardwareLocationLayer.addLayer(hardwareLocationMarker);
    }

    // Auto-center map on first valid physical fix
    if (!hasAutoCenteredHardware && !actuallyStale && activeSection === "map") {
        map.flyTo([lat, lon], 14, { duration: 1.2 });
        hasAutoCenteredHardware = true;
    }
}

/**
 * Fetches the current laptop LAN IP from /api/network-info and updates
 * the connection diagnostics panel so the user can immediately copy
 * the correct BACKEND_URL into firmware/secrets.h.
 */
async function fetchNetworkInfo() {
    try {
        const res = await fetch("/api/network-info");
        if (!res.ok) return;
        const data = await res.json();

        const lanIp = data.laptop_lan_ip || "Unknown";
        const backendUrl = data.backend_url || "N/A";

        // Update diagnostics panel
        const elIp = document.getElementById("diagLanIp");
        const elUrl = document.getElementById("diagBackendUrl");
        const elBadge = document.getElementById("diagStatusBadge");
        const elWarn = document.getElementById("ipChangedWarning");

        if (elIp) elIp.textContent = lanIp;
        if (elUrl) elUrl.textContent = backendUrl;

        // Known previous IPs that may be stale in secrets.h
        const knownStaleIps = ["10.131.244.214"];
        const isIpPotentiallyStale = knownStaleIps.some(ip => !backendUrl.includes(lanIp));
        if (elWarn) {
            // Show warning only if this isn't localhost and we detect mismatch hint
            if (lanIp !== "127.0.0.1" && isIpPotentiallyStale) {
                elWarn.style.display = "block";
                elWarn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
                    <strong>Update secrets.h!</strong> Current laptop IP is <code>${lanIp}</code>.<br>
                    Set <code>BACKEND_URL = "${backendUrl}"</code> in <code>firmware/esp32_roadguard/secrets.h</code> and re-flash.`;
            } else {
                elWarn.style.display = "none";
            }
        }
        if (elBadge) {
            if (lanIp !== "127.0.0.1") {
                elBadge.textContent = "BACKEND REACHABLE";
                elBadge.style.color = "#34D399";
                elBadge.style.borderColor = "rgba(52,211,153,0.4)";
            }
        }
    } catch (e) {
        // Backend not running — don't crash, just leave stale values
        const elBadge = document.getElementById("diagStatusBadge");
        if (elBadge) {
            elBadge.textContent = "BACKEND OFFLINE";
            elBadge.style.color = "#F87171";
            elBadge.style.borderColor = "rgba(239,68,68,0.4)";
        }
    }
}

async function fetchModelStatus() {    try {
        const res = await fetch("/api/model-status");
        if (res.ok) {
            const data = await res.json();
            const modelText = document.getElementById("hwModelText");
            const dashBadge = document.getElementById("dashModelBadge");
            const dashClasses = document.getElementById("dashModelClasses");
            const dashFeatures = document.getElementById("dashModelFeatures");

            if (data.readiness === "MODEL_READY") {
                if (modelText) modelText.innerHTML = `<span style="color:#10B981;">Random Forest (${data.classes.length} Classes, Ready)</span>`;
                if (dashBadge) {
                    dashBadge.textContent = "MODEL OPERATIONAL";
                    dashBadge.style.color = "#34D399";
                    dashBadge.style.borderColor = "rgba(52,211,153,0.4)";
                }
                if (dashClasses) dashClasses.textContent = data.classes.join(", ");
                if (dashFeatures) dashFeatures.textContent = `${data.features_count} Statistical & Spectral Features`;
            } else {
                if (modelText) modelText.innerHTML = `<span style="color:#EF4444;">Model Not Ready (Training Required)</span>`;
                if (dashBadge) {
                    dashBadge.textContent = "MODEL NOT READY";
                    dashBadge.style.color = "#EF4444";
                }
            }
        }
    } catch (e) {
        const modelText = document.getElementById("hwModelText");
        if (modelText) modelText.textContent = "Status Unknown";
    }
}

/**
 * -------------------------------------------------------------
 * 6. Main Polling & Dashboard Overview Refresh
 * -------------------------------------------------------------
 */
async function refreshDashboard() {
    try {
        // 1. Fetch Stats for current mode
        const statsRes = await fetch(`/api/stats?mode=${currentMode}`);
        if (statsRes.ok) {
            const stats = await statsRes.json();
            const elOpen = document.getElementById("kpiOpenReports");
            const elHigh = document.getElementById("kpiHighPriority");
            const elMed = document.getElementById("kpiMediumPriority");
            const elRes = document.getElementById("kpiResolved");
            const elBus = document.getElementById("kpiActiveBuses");

            if (elOpen) elOpen.textContent = stats.open_reports ?? 0;
            if (elHigh) elHigh.textContent = stats.high_priority ?? 0;
            if (elMed) elMed.textContent = stats.medium_priority ?? 0;
            if (elRes) elRes.textContent = stats.resolved ?? 0;
            if (elBus) elBus.textContent = stats.active_buses ?? 1;
        }

        // 2. Fetch Hotspots for current mode
        const hotspotsRes = await fetch(`/api/hotspots?mode=${currentMode}`);
        if (hotspotsRes.ok) {
            const data = await hotspotsRes.json();
            activeHotspots = data.hotspots || [];

            const elMapCount = document.getElementById("dashMapCount");
            if (elMapCount) elMapCount.textContent = `${activeHotspots.length} Hotspots Mapped`;

            renderMarkers();
            renderHotspotsTable();
        }

        // 3. Fetch recent raw detections (includes unlocated hazards with no GPS fix)
        //    These appear in the Live Alerts Stream even before a GPS hotspot is formed.
        try {
            const rawRes = await fetch(`/api/detections?mode=${currentMode}&limit=10`);
            if (rawRes.ok) {
                const rawData = await rawRes.json();
                rawDetections = rawData.detections || [];
            }
        } catch (_) { /* non-fatal — stream will fall back to hotspots */ }

        renderAlertsStream();

        // Refresh specific pages if currently viewed
        if (activeSection === "workflow") renderWorkflowBoard();
        if (activeSection === "alerts" && alertsViewMode === "HOTSPOTS") renderAlertsPage();
    } catch (err) {
        console.warn("Polling update error:", err);
    }
}

/**
 * -------------------------------------------------------------
 * 7. Leaflet Markers Rendering
 * -------------------------------------------------------------
 */
function getMarkerIcon(hazardType, priorityLevel, status, mode) {
    let color = "#0284C7"; // Default rough road blue
    let letter = "R";

    if (status === "VERIFIED") {
        color = "#10B981"; // Resolved emerald
        letter = "✓";
    } else if (hazardType === "POTHOLE") {
        color = "#EF4444"; // Pothole red
        letter = "P";
    } else if (hazardType === "SPEED_BREAKER") {
        color = "#F59E0B"; // Speed breaker amber
        letter = "B";
    } else if (hazardType === "UNKNOWN" || hazardType === "UNCERTAIN") {
        color = "#A855F7";
        letter = "?";
    }

    const isHigh = (priorityLevel === "HIGH" && status !== "VERIFIED");
    const pulseHtml = isHigh ? '<div class="marker-pulse"></div>' : '';
    const modeBadge = (mode === "HARDWARE") ? "HW" : "SIM";

    return L.divIcon({
        className: "custom-hazard-marker",
        html: `
            <div style="position:relative; width:30px; height:30px;">
                ${pulseHtml}
                <div style="
                    width: 26px; height: 26px; border-radius: 50%;
                    background: ${color}; border: 2px solid #FFFFFF;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.45);
                    display: flex; align-items: center; justify-content: center;
                    color: white; font-size: 11px; font-weight: bold;
                ">
                    ${letter}
                </div>
                <div style="
                    position: absolute; bottom: -2px; right: -4px;
                    background: #0F172A; border: 1px solid ${color};
                    border-radius: 3px; font-size: 8px; font-weight: 800;
                    color: #FFFFFF; padding: 0 2px; line-height: 10px;
                ">${modeBadge}</div>
            </div>
        `,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
}

function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();

    const statusFilter = document.getElementById("statusFilter")?.value || "ALL";
    const typeFilter = document.getElementById("typeFilter")?.value || "ALL";

    activeHotspots.forEach(h => {
        if (statusFilter !== "ALL" && h.status !== statusFilter) return;
        if (typeFilter !== "ALL" && h.hazard_type !== typeFilter) return;
        if (currentMode !== "ALL" && h.mode !== currentMode) return;
        if (h.latitude === null || h.longitude === null) return; // Strict coordinate check

        const icon = getMarkerIcon(h.hazard_type, h.priority_level, h.status, h.mode);
        const marker = L.marker([h.latitude, h.longitude], { icon: icon });

        const isHw = (h.mode === "HARDWARE");
        const originTag = isHw
            ? '<span style="background:rgba(16,185,129,0.2); color:#10B981; padding:2px 6px; border-radius:3px; font-weight:700; font-size:10px;">REAL HARDWARE</span>'
            : '<span style="background:rgba(245,158,11,0.2); color:#F59E0B; padding:2px 6px; border-radius:3px; font-weight:700; font-size:10px;">SIMULATED DATA</span>';

        const popupContent = `
            <div style="min-width: 220px; font-family: Inter, sans-serif;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span style="font-weight: 700; font-size: 14px; color: #0F172A;">${h.location_name || "Road Hazard"}</span>
                    ${originTag}
                </div>
                <div style="font-size: 11px; color: #475569; margin-bottom: 8px;">
                    📍 ${h.latitude.toFixed(5)}, ${h.longitude.toFixed(5)}
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px; margin-bottom: 8px;">
                    <div><strong>Hazard:</strong> ${h.hazard_type}</div>
                    <div><strong>Priority:</strong> <span style="font-weight:bold; color:${h.priority_level==='HIGH'?'#DC2626':'#D97706'}">${h.priority_level} (${h.priority_score})</span></div>
                    <div><strong>Passes:</strong> ${h.distinct_rides} (${h.observation_count} hits)</div>
                    <div><strong>Avg Conf:</strong> ${(h.avg_confidence*100).toFixed(0)}%</div>
                </div>
                <div style="font-size: 11px; margin-bottom: 8px;">
                    <strong>Status:</strong> <span class="status-tag status-${h.status.toLowerCase()}">${h.status}</span>
                </div>
                <button onclick="openStatusModal(${h.id}, '${h.location_name || h.hazard_type}', '${h.status}')"
                        style="width: 100%; background: #0284C7; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;">
                    Update Workflow Status
                </button>
            </div>
        `;

        marker.bindPopup(popupContent);
        markersLayer.addLayer(marker);
    });
}

/**
 * -------------------------------------------------------------
 * 8. Dashboard Table & Alert Stream Rendering
 * -------------------------------------------------------------
 */
function renderHotspotsTable() {
    const tbody = document.querySelector("#hotspotsTable tbody");
    if (!tbody) return;

    if (activeHotspots.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center">No ${currentMode.toLowerCase()} hazard reports found.</td></tr>`;
        return;
    }

    tbody.innerHTML = activeHotspots.slice(0, 6).map(h => `
        <tr>
            <td>
                <strong>${h.location_name || "Road Obstacle"}</strong>
                <span style="font-size:9px; color:${h.mode==='HARDWARE'?'#34D399':'#FBBF24'}; margin-left:4px;">[${h.mode}]</span>
            </td>
            <td>${h.hazard_type}</td>
            <td>${h.distinct_rides} passes</td>
            <td><span class="alert-badge badge-${h.priority_level.toLowerCase()}">${h.priority_score}</span></td>
            <td>
                <span class="status-tag status-${h.status.toLowerCase()}" 
                      style="cursor:pointer;" 
                      onclick="openStatusModal(${h.id}, '${h.location_name}', '${h.status}')" 
                      title="Click to update status">
                    ${h.status}
                </span>
            </td>
        </tr>
    `).join("");
}

function renderAlertsStream() {
    const container = document.getElementById("alertsStream");
    if (!container) return;

    // Prefer confirmed GPS hotspots; fall back to recent raw detections (no GPS fix yet)
    if (activeHotspots.length > 0) {
        container.innerHTML = activeHotspots.slice(0, 6).map(h => `
            <div class="alert-item ${h.hazard_type.toLowerCase()}">
                <div>
                    <div class="alert-title">
                        ${h.hazard_type}: ${h.location_name || "Road Obstacle"}
                        <span style="font-size:9px; color:${h.mode==='HARDWARE'?'#34D399':'#FBBF24'}; margin-left:4px;">[${h.mode}]</span>
                    </div>
                    <div class="alert-subtitle">${h.distinct_rides} independent buses • ${h.observation_count} detections</div>
                </div>
                <span class="alert-badge badge-${h.priority_level.toLowerCase()}">${h.priority_level}</span>
            </div>
        `).join("");
        return;
    }

    // No hotspots yet — show raw hardware detections (GPS unavailable phase)
    const recentHazards = rawDetections.filter(d => d.mode === currentMode);
    if (recentHazards.length === 0) {
        container.innerHTML = `<div class="empty-state">No hazard alerts currently flagged for ${currentMode.toLowerCase()} mode.</div>`;
        return;
    }

    container.innerHTML = recentHazards.slice(0, 6).map(d => {
        const hazardColor = d.hazard_type === "POTHOLE" ? "#EF4444"
                          : d.hazard_type === "SPEED_BREAKER" ? "#F59E0B"
                          : "#38BDF8";
        const ts = d.created_at
            ? new Date(d.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
            : "--";
        const location = (d.gps_valid && d.latitude && d.longitude)
            ? `📍 ${parseFloat(d.latitude).toFixed(5)}, ${parseFloat(d.longitude).toFixed(5)}`
            : "📡 No GPS Fix";
        const confPct = d.confidence ? Math.round(d.confidence * 100) + "% conf" : "";
        const severity = d.severity_metric ? ` • ${parseFloat(d.severity_metric).toFixed(2)}g` : "";
        return `
            <div class="alert-item ${d.hazard_type.toLowerCase()}">
                <div>
                    <div class="alert-title" style="color:${hazardColor};">
                        ${d.hazard_type}
                        <span style="font-size:9px; color:#34D399; margin-left:4px;">[HARDWARE · LIVE]</span>
                    </div>
                    <div class="alert-subtitle">${location} · ${ts} ${confPct}${severity}</div>
                </div>
                <span class="alert-badge badge-high" style="background:#1E293B; color:#94A3B8; border:1px solid #334155;">RAW</span>
            </div>
        `;
    }).join("");
}

/**
 * -------------------------------------------------------------
 * 9. View 3: Hazard Alerts Page Controller
 * -------------------------------------------------------------
 */
async function renderAlertsPage() {
    const tbody = document.getElementById("alertsTableBody");
    if (!tbody) return;

    const searchTerm = (document.getElementById("alertsSearchInput")?.value || "").toLowerCase().trim();
    const typeFilter = document.getElementById("alertsTypeFilter")?.value || "ALL";
    const priorityFilter = document.getElementById("alertsPriorityFilter")?.value || "ALL";
    const statusFilter = document.getElementById("alertsStatusFilter")?.value || "ALL";

    if (alertsViewMode === "HOTSPOTS") {
        let items = activeHotspots.filter(h => {
            if (typeFilter !== "ALL" && h.hazard_type !== typeFilter) return false;
            if (priorityFilter !== "ALL" && h.priority_level !== priorityFilter) return false;
            if (statusFilter !== "ALL" && h.status !== statusFilter) return false;
            if (searchTerm) {
                const loc = (h.location_name || "").toLowerCase();
                const haz = (h.hazard_type || "").toLowerCase();
                if (!loc.includes(searchTerm) && !haz.includes(searchTerm)) return false;
            }
            return true;
        });

        if (items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding:2rem;">No matching hazard alerts found.</td></tr>`;
            return;
        }

        tbody.innerHTML = items.map(h => `
            <tr>
                <td>
                    <strong style="color:${h.hazard_type==='POTHOLE'?'#EF4444':h.hazard_type==='SPEED_BREAKER'?'#F59E0B':'#38BDF8'}">
                        ${h.hazard_type}
                    </strong>
                </td>
                <td>
                    <strong>${h.location_name || "Road Segment"}</strong><br>
                    <span style="font-size:11px; color:#64748B;">📍 ${h.latitude.toFixed(5)}, ${h.longitude.toFixed(5)}</span>
                </td>
                <td>
                    <span style="font-size:10px; font-weight:700; color:${h.mode==='HARDWARE'?'#34D399':'#FBBF24'};">
                        [${h.mode}]
                    </span>
                </td>
                <td>${h.distinct_rides} passes (${h.observation_count} hits)</td>
                <td>${(h.avg_confidence * 100).toFixed(0)}% conf • ${h.max_severity ? h.max_severity.toFixed(2) + 'g' : '--'}</td>
                <td><span class="alert-badge badge-${h.priority_level.toLowerCase()}">${h.priority_score} (${h.priority_level})</span></td>
                <td><span class="status-tag status-${h.status.toLowerCase()}">${h.status}</span></td>
                <td>
                    <button class="alert-action-btn" onclick="focusHotspotOnMap(${h.latitude}, ${h.longitude})">
                        <i class="fa-solid fa-map-location-dot"></i> Map
                    </button>
                    <button class="alert-action-btn" onclick="openStatusModal(${h.id}, '${h.location_name || h.hazard_type}', '${h.status}')">
                        <i class="fa-solid fa-pen-to-square"></i> Status
                    </button>
                </td>
            </tr>
        `).join("");
    } else {
        // Raw Telemetry Mode
        tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding:1.5rem;">Fetching live raw sensor detections...</td></tr>`;
        try {
            const res = await fetch(`/api/detections?mode=${currentMode}&limit=50`);
            if (res.ok) {
                const data = await res.json();
                const detections = data.detections || [];
                if (detections.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding:2rem;">No raw detections recorded yet for ${currentMode}. Connect hardware or run bus simulation.</td></tr>`;
                    return;
                }

                tbody.innerHTML = detections.map(d => `
                    <tr>
                        <td><strong>${d.hazard_type}</strong></td>
                        <td>
                            <span>Device: <code>${d.device_id || "ESP32"}</code> • Ride: <code>${d.ride_id || "--"}</code></span><br>
                            <span style="font-size:11px; color:#64748B;">
                                ${d.latitude && d.longitude ? `📍 ${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}` : "No GPS Fix"}
                            </span>
                        </td>
                        <td><span style="font-size:10px; font-weight:700; color:${d.mode==='HARDWARE'?'#34D399':'#FBBF24'};">[${d.mode}]</span></td>
                        <td>Seq #${d.seq_num || 0}</td>
                        <td>${(d.confidence * 100).toFixed(0)}% • ${d.severity_metric ? d.severity_metric.toFixed(2) + 'g' : '--'}</td>
                        <td>--</td>
                        <td><span class="status-tag status-detected">${d.gps_valid ? "GEOTAGGED" : "UNLOCATED"}</span></td>
                        <td>
                            ${d.latitude && d.longitude ? `
                                <button class="alert-action-btn" onclick="focusHotspotOnMap(${d.latitude}, ${d.longitude})">
                                    <i class="fa-solid fa-map-location-dot"></i> View
                                </button>
                            ` : `<span style="font-size:11px; color:#64748B;">No GPS</span>`}
                        </td>
                    </tr>
                `).join("");
            }
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="color:#EF4444;">Failed to fetch raw detections.</td></tr>`;
        }
    }
}

function focusHotspotOnMap(lat, lon) {
    navigateTo("map");
    setTimeout(() => {
        if (map) {
            map.flyTo([lat, lon], 16, { duration: 1.0 });
        }
    }, 200);
}

/**
 * -------------------------------------------------------------
 * 10. View 4: Repair Workflow Kanban Board Controller
 * -------------------------------------------------------------
 */
function renderWorkflowBoard() {
    const colDetected = document.getElementById("colCardsDetected");
    const colInspection = document.getElementById("colCardsInspection");
    const colRepair = document.getElementById("colCardsRepair");
    const colVerified = document.getElementById("colCardsVerified");

    if (!colDetected || !colInspection || !colRepair || !colVerified) return;

    const cards = {
        DETECTED: [],
        INSPECTION_REQUESTED: [],
        REPAIR_IN_PROGRESS: [],
        VERIFIED: []
    };

    activeHotspots.forEach(h => {
        if (cards[h.status]) {
            cards[h.status].push(h);
        }
    });

    // Update column counters
    document.getElementById("countDetected").textContent = cards.DETECTED.length;
    document.getElementById("countInspection").textContent = cards.INSPECTION_REQUESTED.length;
    document.getElementById("countRepair").textContent = cards.REPAIR_IN_PROGRESS.length;
    document.getElementById("countVerified").textContent = cards.VERIFIED.length;

    function renderColumnCards(items, nextStatus, nextLabel) {
        if (items.length === 0) {
            return '<div class="kanban-empty">No hazards in this stage</div>';
        }

        return items.map(h => `
            <div class="kanban-card">
                <div class="kanban-card-top">
                    <span class="status-tag status-${h.status.toLowerCase()}">${h.hazard_type}</span>
                    <span class="alert-badge badge-${h.priority_level.toLowerCase()}">${h.priority_level} (${h.priority_score})</span>
                </div>
                <div class="kanban-card-title">${h.location_name || "Road Obstacle"}</div>
                <div class="kanban-card-coords">📍 ${h.latitude.toFixed(5)}, ${h.longitude.toFixed(5)} [${h.mode}]</div>
                <div class="kanban-card-meta">
                    <span>${h.distinct_rides} bus passes</span>
                    <span>Max: ${h.max_severity ? h.max_severity.toFixed(2) + 'g' : '--'}</span>
                </div>
                <div class="kanban-card-actions">
                    <button class="kanban-btn-edit" onclick="openStatusModal(${h.id}, '${h.location_name || h.hazard_type}', '${h.status}')">
                        <i class="fa-solid fa-notes-medical"></i> Audit
                    </button>
                    ${nextStatus ? `
                        <button class="kanban-btn-advance" onclick="quickAdvanceStatus(${h.id}, '${nextStatus}')">
                            ${nextLabel} <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    ` : `
                        <span style="font-size:11px; color:#10B981; font-weight:700;"><i class="fa-solid fa-check-double"></i> Complete</span>
                    `}
                </div>
            </div>
        `).join("");
    }

    colDetected.innerHTML = renderColumnCards(cards.DETECTED, "INSPECTION_REQUESTED", "Assign Crew");
    colInspection.innerHTML = renderColumnCards(cards.INSPECTION_REQUESTED, "REPAIR_IN_PROGRESS", "Start Repair");
    colRepair.innerHTML = renderColumnCards(cards.REPAIR_IN_PROGRESS, "VERIFIED", "Verify Fix");
    colVerified.innerHTML = renderColumnCards(cards.VERIFIED, null, null);
}

async function quickAdvanceStatus(hotspotId, nextStatus) {
    try {
        const res = await fetch(`/api/hotspots/${hotspotId}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                status: nextStatus,
                notes: `Promoted via Kanban board to ${nextStatus}`,
                updated_by: "PMC Municipal Road Engineer"
            })
        });
        if (res.ok) {
            refreshDashboard();
        } else {
            alert("Failed to advance status.");
        }
    } catch (e) {
        alert("Backend connection error.");
    }
}

/**
 * -------------------------------------------------------------
 * 11. View 5: PMPML Bus Fleet Page Controller
 * -------------------------------------------------------------
 */
async function renderFleetPage() {
    const container = document.getElementById("fleetContainer");
    if (!container) return;

    try {
        const res = await fetch("/api/device-status");
        if (res.ok) {
            const data = await res.json();
            const devices = data.devices || [];

            if (devices.length === 0) {
                // Honest empty state with hardware connection guide (Do NOT invent fake bus locations)
                container.innerHTML = `
                    <div class="fleet-empty-box">
                        <i class="fa-solid fa-microchip fleet-empty-icon"></i>
                        <h3>No Physical ESP32 Fleet Units Currently Streaming</h3>
                        <p>
                            RoadGuard AI operates on live telemetry from ESP32 edge units mounted on PMPML transit buses.
                            No synthetic bus units are fabricated on this screen to ensure data integrity.
                        </p>
                        <div class="fleet-guide-steps">
                            <strong style="color:#F8FAFC;"><i class="fa-solid fa-plug-circle-bolt"></i> How to Connect Your Physical Hardware:</strong>
                            <div class="guide-step">
                                <span class="guide-step-num">1</span>
                                <div><strong>Flash Firmware:</strong> Open <code>firmware/esp32_roadguard/esp32_roadguard.ino</code> in Arduino IDE or PlatformIO.</div>
                            </div>
                            <div class="guide-step">
                                <span class="guide-step-num">2</span>
                                <div><strong>Configure Wi-Fi:</strong> Enter your Wi-Fi SSID and Password in the firmware constants.</div>
                            </div>
                            <div class="guide-step">
                                <span class="guide-step-num">3</span>
                                <div><strong>Set Server URL:</strong> Configure <code>SERVER_URL</code> to <code>http://&lt;your-laptop-ip&gt;:5000/api/telemetry</code>.</div>
                            </div>
                            <div class="guide-step">
                                <span class="guide-step-num">4</span>
                                <div><strong>Verify Wiring:</strong> MPU6050 (SDA=21, SCL=22) and NEO-7M/M8N GPS (UART2: RX=16, TX=17).</div>
                            </div>
                            <div class="guide-step">
                                <span class="guide-step-num">5</span>
                                <div><strong>Power On:</strong> Plug ESP32 into vehicle power. Telemetry heartbeats will appear here automatically.</div>
                            </div>
                        </div>
                        <div style="display:flex; gap:0.75rem; margin-top:0.5rem;">
                            <button class="btn btn-primary" onclick="triggerLiveSimulation()">
                                <i class="fa-solid fa-play"></i> Simulate PMPML Bus Test Run
                            </button>
                            <button class="btn btn-secondary" onclick="fetchDeviceStatus(); renderFleetPage();">
                                <i class="fa-solid fa-rotate-right"></i> Check Connection Again
                            </button>
                        </div>
                    </div>
                `;
            } else {
                // Render real connected device cards
                container.innerHTML = `
                    <div class="fleet-grid">
                        ${devices.map(d => `
                            <div class="fleet-card">
                                <div class="fleet-card-header">
                                    <div class="fleet-card-id">
                                        <i class="fa-solid fa-bus"></i>
                                        <span>${d.device_id}</span>
                                    </div>
                                    <span class="hw-indicator ${d.status === 'ONLINE' ? 'dot-online' : 'dot-offline'}"></span>
                                </div>
                                <div class="fleet-card-body">
                                    <div class="dash-stat-row">
                                        <span class="stat-name"><i class="fa-solid fa-wifi"></i> Status:</span>
                                        <span class="stat-val" style="color:${d.status === 'ONLINE' ? '#10B981' : '#EF4444'};">${d.status}</span>
                                    </div>
                                    <div class="dash-stat-row">
                                        <span class="stat-name"><i class="fa-solid fa-network-wired"></i> IP Address:</span>
                                        <span class="stat-val"><code>${d.ip_address || "LAN"}</code></span>
                                    </div>
                                    <div class="dash-stat-row">
                                        <span class="stat-name"><i class="fa-solid fa-satellite"></i> GPS Receiver:</span>
                                        <span class="stat-val" style="color:${d.gps_fix ? '#10B981' : '#F59E0B'};">
                                            ${d.gps_fix ? `3D Fix (${d.satellites} Sats • HDOP ${d.hdop})` : `Acquiring (${d.satellites} Sats)`}
                                        </span>
                                    </div>
                                    <div class="dash-stat-row">
                                        <span class="stat-name"><i class="fa-solid fa-hashtag"></i> Last Packet Seq:</span>
                                        <span class="stat-val">#${d.last_seq_num || 0}</span>
                                    </div>
                                    <div class="dash-stat-row">
                                        <span class="stat-name"><i class="fa-solid fa-code-commit"></i> Firmware:</span>
                                        <span class="stat-val">v${d.firmware_version || "1.0.0"}</span>
                                    </div>
                                    <div class="dash-stat-row">
                                        <span class="stat-name"><i class="fa-solid fa-clock"></i> Last Seen:</span>
                                        <span class="stat-val">${d.seconds_since_seen}s ago</span>
                                    </div>
                                </div>
                            </div>
                        `).join("")}
                    </div>
                `;
            }
        }
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Failed to query device registry.</div>`;
    }
}

/**
 * -------------------------------------------------------------
 * 12. View 6: Analytics & Trends Page Controller
 * -------------------------------------------------------------
 */
async function renderAnalyticsPage() {
    try {
        const res = await fetch(`/api/analytics?mode=${currentMode}`);
        if (!res.ok) return;
        const data = await res.json();

        // 1. Update KPI Summary Numbers
        const total = data.total_hotspots || 0;
        const verified = (data.by_status && data.by_status.VERIFIED) ? data.by_status.VERIFIED : 0;
        const resolutionRate = total > 0 ? Math.round((verified / total) * 100) : 0;

        document.getElementById("anaTotalHotspots").textContent = total;
        document.getElementById("anaRawCount").textContent = data.total_raw_detections || 0;
        document.getElementById("anaResolutionRate").textContent = `${resolutionRate}%`;
        document.getElementById("anaAvgConfidence").textContent = `${Math.round((data.avg_confidence || 0) * 100)}%`;
        document.getElementById("anaMaxSeverity").textContent = `${(data.max_severity || 0).toFixed(2)}g`;

        // 2. Chart 1: Hazard Distribution by Type
        const ctxType = document.getElementById("chartHazardType");
        if (ctxType) {
            if (chartInstances.type) chartInstances.type.destroy();
            const typeLabels = Object.keys(data.by_type || {});
            const typeCounts = Object.values(data.by_type || {});

            chartInstances.type = new Chart(ctxType, {
                type: "doughnut",
                data: {
                    labels: typeLabels.length ? typeLabels : ["No Data"],
                    datasets: [{
                        data: typeCounts.length ? typeCounts : [1],
                        backgroundColor: ["#EF4444", "#F59E0B", "#0284C7", "#A855F7"],
                        borderWidth: 2,
                        borderColor: "#1E293B"
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: "bottom", labels: { color: "#94A3B8", font: { family: "Inter" } } }
                    }
                }
            });
        }

        // 3. Chart 2: Repair Workflow Pipeline
        const ctxWorkflow = document.getElementById("chartWorkflowStatus");
        if (ctxWorkflow) {
            if (chartInstances.workflow) chartInstances.workflow.destroy();
            const stMap = data.by_status || {};
            chartInstances.workflow = new Chart(ctxWorkflow, {
                type: "bar",
                data: {
                    labels: ["Detected", "Inspection", "In Repair", "Verified"],
                    datasets: [{
                        label: "Hotspots",
                        data: [
                            stMap.DETECTED || 0,
                            stMap.INSPECTION_REQUESTED || 0,
                            stMap.REPAIR_IN_PROGRESS || 0,
                            stMap.VERIFIED || 0
                        ],
                        backgroundColor: ["#EF4444", "#F59E0B", "#0284C7", "#10B981"],
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { ticks: { color: "#94A3B8" }, grid: { display: false } },
                        y: { ticks: { color: "#94A3B8", stepSize: 1 }, grid: { color: "#334155" } }
                    }
                }
            });
        }

        // 4. Chart 3: Priority Severity Breakdown
        const ctxPriority = document.getElementById("chartPriority");
        if (ctxPriority) {
            if (chartInstances.priority) chartInstances.priority.destroy();
            const prioMap = data.by_priority || {};
            chartInstances.priority = new Chart(ctxPriority, {
                type: "pie",
                data: {
                    labels: ["High Priority", "Medium Priority", "Low Priority"],
                    datasets: [{
                        data: [prioMap.HIGH || 0, prioMap.MEDIUM || 0, prioMap.LOW || 0],
                        backgroundColor: ["#EF4444", "#F59E0B", "#38BDF8"],
                        borderWidth: 2,
                        borderColor: "#1E293B"
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: "bottom", labels: { color: "#94A3B8", font: { family: "Inter" } } }
                    }
                }
            });
        }

        // 5. Chart 4: Top Corridors by Hazard Density
        const ctxCorridors = document.getElementById("chartCorridors");
        if (ctxCorridors) {
            if (chartInstances.corridors) chartInstances.corridors.destroy();
            const corridors = data.corridors || [];
            chartInstances.corridors = new Chart(ctxCorridors, {
                type: "bar",
                data: {
                    labels: corridors.map(c => c.name),
                    datasets: [{
                        label: "Observed Hazards",
                        data: corridors.map(c => c.count),
                        backgroundColor: "#38BDF8",
                        borderRadius: 4
                    }]
                },
                options: {
                    indexAxis: "y",
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { ticks: { color: "#94A3B8", stepSize: 1 }, grid: { color: "#334155" } },
                        y: { ticks: { color: "#94A3B8", font: { size: 10 } }, grid: { display: false } }
                    }
                }
            });
        }
    } catch (err) {
        console.warn("Analytics render error:", err);
    }
}

/**
 * -------------------------------------------------------------
 * 13. Status Transition Modal Functions
 * -------------------------------------------------------------
 */
function openStatusModal(id, locationName, currentStatus) {
    const elId = document.getElementById("modalHotspotId");
    const elInfo = document.getElementById("modalHotspotInfo");
    const elSelect = document.getElementById("modalNewStatus");

    if (elId) elId.value = id;
    if (elInfo) elInfo.innerHTML = `Updating hotspot: <strong>${locationName}</strong> (Current: <em>${currentStatus}</em>)`;
    if (elSelect) elSelect.value = currentStatus;

    const modal = document.getElementById("statusModal");
    if (modal) modal.classList.add("show");
}

function closeStatusModal() {
    const modal = document.getElementById("statusModal");
    if (modal) modal.classList.remove("show");
}

async function submitStatusUpdate() {
    const id = document.getElementById("modalHotspotId").value;
    const newStatus = document.getElementById("modalNewStatus").value;
    const notes = document.getElementById("modalNotes").value;

    try {
        const res = await fetch(`/api/hotspots/${id}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus, notes: notes })
        });
        if (res.ok) {
            closeStatusModal();
            refreshDashboard();
            if (activeSection === "workflow") renderWorkflowBoard();
            if (activeSection === "alerts") renderAlertsPage();
        } else {
            alert("Failed to update status.");
        }
    } catch (e) {
        alert("Error connecting to backend.");
    }
}

/**
 * -------------------------------------------------------------
 * 14. Seed Demo Hotspots & Live Simulation
 * -------------------------------------------------------------
 */
async function seedPuneDemoHotspots() {
    const btn = document.getElementById("btnSeedDemo");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Seeding...';
    }

    try {
        const res = await fetch("/api/demo/seed", { method: "POST" });
        if (res.ok) {
            const modeSelect = document.getElementById("systemModeSelect");
            if (modeSelect && modeSelect.value === "HARDWARE") {
                modeSelect.value = "ALL";
                currentMode = "ALL";
            }
            refreshDashboard();
            if (activeSection === "analytics") renderAnalyticsPage();
            if (activeSection === "workflow") renderWorkflowBoard();
            if (activeSection === "alerts") renderAlertsPage();
        }
    } catch (e) {
        console.error(e);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-database"></i> Seed Pune Hotspots';
        }
    }
}

async function triggerLiveSimulation() {
    const btn = document.getElementById("btnRunSim");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-bus fa-bounce"></i> Simulating Bus...';
    }

    await seedPuneDemoHotspots();

    setTimeout(() => {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-play"></i> Run Bus Simulation';
        }
        if (map) {
            map.flyTo([18.5204, 73.8567], 13, { duration: 1.5 });
        }
    }, 1200);
}
