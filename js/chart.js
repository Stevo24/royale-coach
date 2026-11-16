// One-series line chart as inline SVG, with a crosshair + tooltip and a table view.
const W = 340, H = 150, PAD = { l: 26, r: 34, t: 10, b: 20 };
const LINE = "#3987e5"; // validated against the card surface for contrast and colour-blind safety

// points: [{ label, value }] oldest first (2+). par: a reference value drawn as a labelled line.
export function lineChart(id, points, par) {
  const values = points.map((p) => p.value);
  const lo = Math.max(0, Math.floor((Math.min(...values, par) - 8) / 10) * 10);
  const hi = Math.min(100, Math.ceil((Math.max(...values, par) + 8) / 10) * 10);
  const x = (i) => PAD.l + (i * (W - PAD.l - PAD.r)) / (points.length - 1);
  const y = (v) => PAD.t + ((hi - v) * (H - PAD.t - PAD.b)) / (hi - lo);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  const grid = [lo, hi].map((v) => `
    <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>
    <text x="${PAD.l - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`).join("");
  return `
    <div class="chart" id="${id}" data-points='${JSON.stringify(points).replace(/'/g, "&#39;")}' data-geo='${JSON.stringify({ l: PAD.l, r: W - PAD.r, lo, hi, t: PAD.t, b: H - PAD.b })}'>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Skill score over time">
        ${grid}
        <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(par)}" y2="${y(par)}" stroke="var(--muted)" stroke-width="1"/>
        <text x="${W - PAD.r + 5}" y="${y(par) + 4}" class="ax">par</text>
        <path d="${path}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(last)}" cy="${y(values[last])}" r="5" fill="${LINE}" stroke="var(--panel)" stroke-width="2"/>
        <text x="${x(last) + 9}" y="${y(values[last]) + (Math.abs(y(values[last]) - y(par)) < 12 ? -8 : 4)}" class="val">${values[last]}</text>
        <text x="${PAD.l}" y="${H - 4}" class="ax"></text>
        <text x="${W - PAD.r}" y="${H - 4}" text-anchor="end" class="ax"></text>
        <g class="cross" visibility="hidden">
          <line y1="${PAD.t}" y2="${H - PAD.b}" stroke="var(--muted)" stroke-width="1"/>
          <circle r="5" fill="${LINE}" stroke="var(--panel)" stroke-width="2"/>
        </g>
      </svg>
      <div class="chart-tip hidden"></div>
      <details class="small"><summary class="muted">Show as table</summary><table></table></details>
    </div>`;
}

// Fill in text (as text, never HTML) and wire the crosshair. Call after the chart is in the page.
export function bindChart(id) {
  const root = document.getElementById(id);
  if (!root) return;
  const points = JSON.parse(root.dataset.points), geo = JSON.parse(root.dataset.geo);
  const svg = root.querySelector("svg"), cross = root.querySelector(".cross"), tip = root.querySelector(".chart-tip");
  const axis = svg.querySelectorAll("text.ax");
  axis[axis.length - 2].textContent = points[0].label;
  axis[axis.length - 1].textContent = points.at(-1).label;
  const table = root.querySelector("table");
  for (const p of [...points].reverse()) {
    const row = table.insertRow();
    row.insertCell().textContent = p.label;
    row.insertCell().textContent = p.value;
  }
  const x = (i) => geo.l + (i * (geo.r - geo.l)) / (points.length - 1);
  const y = (v) => geo.t + ((geo.hi - v) * (geo.b - geo.t)) / (geo.hi - geo.lo);
  const show = (event) => {
    const box = svg.getBoundingClientRect();
    const sx = ((event.clientX - box.left) / box.width) * 340;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((sx - geo.l) / (geo.r - geo.l)) * (points.length - 1))));
    cross.setAttribute("visibility", "visible");
    cross.querySelector("line").setAttribute("x1", x(i));
    cross.querySelector("line").setAttribute("x2", x(i));
    cross.querySelector("circle").setAttribute("cx", x(i));
    cross.querySelector("circle").setAttribute("cy", y(points[i].value));
    tip.textContent = `${points[i].label} · Skill score ${points[i].value}`;
    tip.classList.remove("hidden");
    tip.style.left = `${Math.max(0, Math.min(box.width - tip.offsetWidth, (x(i) / 340) * box.width - tip.offsetWidth / 2))}px`;
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); tip.classList.add("hidden"); };
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerleave", hide);
}
