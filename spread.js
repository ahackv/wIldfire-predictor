const map = document.getElementById("perimeter-map");
const context = map.getContext("2d");
const distance = document.getElementById("spread-distance");
const reveal = document.getElementById("spread-reveal");
const result = document.getElementById("spread-result");
const legend = document.getElementById("observed-legend");
const status = document.getElementById("spread-status");
const acreage = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const overlap = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
let incident;
let revealed = false;

function eachPolygon(geometry) {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function mapProjection() {
  const [west, south, east, north] = incident.bbox;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const longitudeScale = Math.cos(centerLat * Math.PI / 180);
  const padding = 0.005;
  const scale = Math.min((map.width - 56) / ((east - west + padding * 2) * longitudeScale),
    (map.height - 56) / (north - south + padding * 2));
  return {
    point: ([lon, lat]) => [map.width / 2 + (lon - centerLon) * longitudeScale * scale,
      map.height / 2 - (lat - centerLat) * scale],
    kilometre: scale / 111.2,
  };
}

function drawShape(geometry, projection, { stroke, fill = "transparent", width = 2, dash = [] }) {
  context.beginPath();
  for (const polygon of eachPolygon(geometry)) {
    for (const ring of polygon) {
      context.moveTo(...projection.point(ring[0]));
      for (const coordinate of ring.slice(1)) context.lineTo(...projection.point(coordinate));
      context.closePath();
    }
  }
  context.fillStyle = fill;
  context.fill("evenodd");
  context.strokeStyle = stroke;
  context.lineWidth = width;
  context.setLineDash(dash);
  context.stroke();
  context.setLineDash([]);
}

function drawMap(scenario) {
  if (!context) return;
  const projection = mapProjection();
  context.clearRect(0, 0, map.width, map.height);
  context.strokeStyle = "#29423e";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 30; x < map.width; x += 50) {
    context.moveTo(x, 0);
    context.lineTo(x, map.height);
  }
  for (let y = 30; y < map.height; y += 50) {
    context.moveTo(0, y);
    context.lineTo(map.width, y);
  }
  context.stroke();

  if (scenario.metres) {
    drawShape(scenario.geometry, projection, { stroke: "#f5bd66", fill: "#f5bd6644", width: 2.5 });
  }
  drawShape(incident.features[0].geometry, projection, { stroke: "#aec7d0", fill: "#29423e", width: 2.8 });
  if (revealed) {
    drawShape(incident.features[1].geometry, projection, { stroke: "#85e9bc", width: 3.2, dash: [8, 5] });
  }

  context.fillStyle = "#c3d4cb";
  context.font = "20px system-ui, sans-serif";
  context.fillText("N ↑", 30, 43);
  context.fillText("1 km", 30, map.height - 37);
  context.fillRect(30, map.height - 28, projection.kilometre, 3);
}

function render() {
  const metres = Number(distance.value);
  const scenario = incident.scenarios.find(option => option.metres === metres);
  drawMap(scenario);
  map.setAttribute("aria-label", `First Dome Fire perimeter and ${metres} metre expansion scenario${revealed ? ", with the later observed perimeter shown" : ""}`);
  result.hidden = !revealed;
  legend.hidden = !revealed;
  reveal.textContent = revealed ? "Hide next perimeter" : "Reveal next perimeter";
  reveal.setAttribute("aria-expanded", String(revealed));
  if (!revealed) return;
  const metrics = scenario.metrics;
  document.getElementById("spread-captured").textContent = `${acreage.format(metrics.capturedAcres)} acres`;
  document.getElementById("spread-missed").textContent = `${acreage.format(metrics.missedAcres)} acres`;
  document.getElementById("spread-extra").textContent = `${acreage.format(metrics.extraAcres)} acres`;
  document.getElementById("spread-overlap").textContent = overlap.format(metrics.iou);
}

distance.addEventListener("change", render);
reveal.addEventListener("click", () => {
  revealed = !revealed;
  render();
});

fetch("./data/dome-perimeters.geojson").then(response => {
  if (!response.ok) throw new Error("Could not load perimeters");
  return response.json();
}).then(payload => {
  incident = payload;
  distance.disabled = false;
  reveal.disabled = false;
  status.hidden = true;
  render();
}).catch(() => {
  status.textContent = "Perimeters could not be loaded. Reload the page to try again.";
});
