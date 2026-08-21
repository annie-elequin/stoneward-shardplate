/* Stoneward Shardplate — site shell, router, progress tracking, Linear bridge. */

const STORE_PROGRESS = "shardplate.progress.v1";
const STORE_LINEAR = "shardplate.linear.v1";
const STORE_BUILDER = "shardplate.builder.v1";

/* ------------------------------------------------------------------ util */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    toast("Could not save — browser storage is blocked");
  }
}

let toastTimer;
function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

async function copy(text, msg = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(msg);
  }
}

/* -------------------------------------------------------- render helpers */

function table(headers, rows, opts = {}) {
  const { align = [], rowClass = [], totalRow = -1 } = opts;
  const th = headers
    .map((h, i) => `<th class="${align[i] === "num" ? "num" : ""}">${esc(h)}</th>`)
    .join("");
  const tb = rows
    .map((r, ri) => {
      const cls = [rowClass[ri] ? `r-${rowClass[ri]}` : "", ri === totalRow ? "total" : ""]
        .filter(Boolean)
        .join(" ");
      const tds = r
        .map((c, i) => `<td class="${align[i] === "num" ? "num" : ""}">${c === null ? "" : esc(c)}</td>`)
        .join("");
      return `<tr class="${cls}">${tds}</tr>`;
    })
    .join("");
  return `<div class="tw"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

const callout = (tone, title, ...paras) =>
  `<div class="callout ${tone}"><h4>${esc(title)}</h4>${paras
    .map((p) => `<p>${p}</p>`)
    .join("")}</div>`;

const note = (t) => `<p class="note">${t}</p>`;

function statRow(stats) {
  return `<div class="stats">${stats
    .map(
      (s) =>
        `<div class="stat ${s.tone || ""}"><div class="v">${esc(s.value)}</div><div class="l">${esc(
          s.label
        )}</div></div>`
    )
    .join("")}</div>`;
}

function barChart(rows, unit = "") {
  const max = Math.max(...rows.map((r) => r[1]));
  const total = rows.reduce((s, r) => s + r[1], 0);
  return `<div class="barchart">${rows
    .map(
      ([label, v]) => `<div class="barrow">
        <div class="bl">${esc(label)}</div>
        <div class="bt"><i style="width:${(v / max) * 100}%"></i></div>
        <div class="bv">${v.toLocaleString()}${unit} · ${Math.round((v / total) * 100)}%</div>
      </div>`
    )
    .join("")}</div>`;
}

function kv(pairs) {
  return `<div class="kv">${pairs
    .map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`)
    .join("")}</div>`;
}

/* ---------------------------------------------------------- procurement */

const shopByName = () => {
  const map = new Map();
  for (const row of DATA.shopping) map.set(row[0], row);
  return map;
};

function blocksForWeek(week) {
  return DATA.procurementByBlock.filter((b) => week >= b.weekStart && week <= b.weekEnd);
}

function procurementItemsForWeek(week) {
  const seen = new Set();
  const rows = [];
  for (const block of blocksForWeek(week)) {
    for (const name of block.items) {
      if (seen.has(name)) continue;
      seen.add(name);
      const shop = shopByName().get(name);
      rows.push({
        name,
        qty: shop ? shop[1] : "—",
        usd: shop ? shop[2] : 0,
        block: block.block,
        missing: !shop,
      });
    }
  }
  return rows.sort((a, b) => a.block - b.block || a.name.localeCompare(b.name));
}

function procurementSpendThroughWeek(week) {
  let total = 0;
  const seen = new Set();
  for (const block of DATA.procurementByBlock) {
    if (block.weekStart > week) continue;
    for (const name of block.items) {
      if (seen.has(name)) continue;
      seen.add(name);
      const shop = shopByName().get(name);
      if (shop) total += shop[2];
    }
  }
  return total;
}

function weekCalendarDate(week, startIso) {
  if (!startIso) return null;
  const start = new Date(startIso + "T12:00:00");
  if (Number.isNaN(start.getTime())) return null;
  const d = new Date(start);
  d.setDate(d.getDate() + (week - 1) * 7);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function loadBuilder() {
  return load(STORE_BUILDER, { startDate: "", week: 1, view: "week" });
}

function saveBuilder(cfg) {
  save(STORE_BUILDER, cfg);
}

/* --------------------------------------------------------------- progress */

let progress = load(STORE_PROGRESS, {});

const allStepIds = () => DATA.phases.flatMap((p) => p.steps.map((s) => s[0]));

/* Optimistic: the box moves immediately, then Linear is told. If Linear
   refuses, both the box and the local cache roll back to where they were. */
async function setStep(id, done, box) {
  const prev = !!progress[id];
  if (done) progress[id] = true;
  else delete progress[id];
  save(STORE_PROGRESS, progress);
  refreshProgressUI();

  if (!linearConnected()) return;

  try {
    await linearPush(id, done);
    if (done) Linear.remote[id] = true;
    else delete Linear.remote[id];
  } catch (err) {
    if (prev) progress[id] = true;
    else delete progress[id];
    save(STORE_PROGRESS, progress);
    if (box) box.checked = prev;
    refreshProgressUI();
    toast(err.message);
  }
}

function phaseStats(phase) {
  const done = phase.steps.filter((s) => progress[s[0]]).length;
  return { done, total: phase.steps.length, pct: (done / phase.steps.length) * 100 };
}

/* ----------------------------------------------------------- linear bridge */

const linearCfg = () => load(STORE_LINEAR, { workspace: "", team: "" });

function linearIssueText(title, body) {
  return `${title}\n\n${body}`;
}

function linearUrl(title, description) {
  const c = linearCfg();
  if (!c.workspace) return null;
  const base = c.team
    ? `https://linear.app/${encodeURIComponent(c.workspace)}/team/${encodeURIComponent(c.team)}/new`
    : `https://linear.app/${encodeURIComponent(c.workspace)}/new`;
  return `${base}?title=${encodeURIComponent(title)}&description=${encodeURIComponent(description)}`;
}

function sendToLinear(title, description) {
  const url = linearUrl(title, description);
  copy(linearIssueText(title, description), url ? "Copied — opening Linear" : "Copied for Linear");
  if (url) window.open(url, "_blank", "noopener");
}

function linearPanel() {
  const projectLink =
    Linear.map && Linear.map.project && Linear.map.project.url
      ? ` &middot; <a href="${esc(Linear.map.project.url)}" target="_blank" rel="noopener">open the project in Linear</a>`
      : "";

  if (Linear.status === "unseeded")
    return `<div class="callout warn"><h4>Linear sync is not set up yet</h4>
      <p>The build steps have not been created as Linear issues, so checkboxes are saved in this browser only &mdash; nobody else sees them. Once the issues exist and <code>assets/js/linear-map.json</code> is committed, this panel turns into a connect box.</p></div>`;

  if (Linear.status === "off")
    return `<div class="callout info"><h4>Connect Linear to share progress</h4>
      <p>Right now these checkboxes live in this browser only. Paste a Linear personal API key and every box becomes the real state of a Linear issue &mdash; so you and the crew all see the same progress from any device.</p>
      <div class="keyrow">
        <input type="password" id="lk" placeholder="lin_api_..." autocomplete="off" spellcheck="false" aria-label="Linear API key">
        <button class="btn primary" data-act="linear-connect">Connect</button>
      </div>
      <p class="fine">Create one at <a href="https://linear.app/settings/api" target="_blank" rel="noopener">linear.app/settings/api</a>. The key is stored only in your own browser and is never sent anywhere except Linear. It carries your full Linear access, so use your own rather than sharing one.${projectLink}</p>
    </div>`;

  if (Linear.status === "error")
    return `<div class="callout bad"><h4>Linear is not responding</h4>
      <p>${esc(Linear.error)}</p>
      <p>Checkboxes are falling back to this browser only, so anything you tick now will not reach Linear until this is fixed.</p>
      <div class="toolbar" style="margin:12px 0 0">
        <button class="btn" data-act="linear-sync">Retry</button>
        <button class="btn" data-act="linear-disconnect">Remove key</button>
      </div>
    </div>`;

  const done = Object.keys(Linear.remote).length;
  return `<div class="callout good"><h4>Synced with Linear</h4>
    <p>Signed in as <strong>${esc(Linear.viewer.name)}</strong>. Linear is the source of truth &mdash; these boxes show live issue states, and ticking one moves the issue to Done. ${done} of ${
    allStepIds().length
  } steps are complete there${projectLink}.</p>
    ${Linear.warning ? `<p class="fine">${esc(Linear.warning)}, so those steps will not sync.</p>` : ""}
    <div class="toolbar" style="margin:12px 0 0">
      <button class="btn" data-act="linear-sync">Sync now</button>
      <button class="btn" data-act="linear-disconnect">Disconnect</button>
    </div>
  </div>`;
}

async function linearRefresh(msg) {
  await linearInit();
  if (linearConnected()) {
    progress = { ...Linear.remote };
    save(STORE_PROGRESS, progress);
  }
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
  if (msg) toast(msg);
}

/* ------------------------------------------------------------------ pages */

const PAGES = {};

PAGES.overview = () => `
  <h2 class="page-title">Stoneward Shardplate</h2>
  <p class="page-lede">${esc(DATA.meta.subtitle)}</p>
  ${statRow(DATA.meta.stats)}
  ${note(esc(DATA.meta.measurements))}

  ${callout(
    "info",
    "Recommendation",
    `Build living Radiant Plate in peakspren language: matte granite facets separated by crystalline veins that leak topaz light, with crystal accretions growing at the joint crowns. EVA foam is the volume, filament is the geometry and the threads, cast urethane is the surface and the optics. Every array of many small overlapping plates &mdash; the fauld, the hamstring lames, the armpit and knee-back clusters &mdash; is PETG printed directly onto black organza, because in those assemblies the fasteners weigh more than the plates do.`,
    `The dividing rule is one sentence: <strong>foam buys volume, filament buys geometry and threads, resin buys surface and optics.</strong> If a part needs two of those, it is not one part &mdash; split it at the seam.`
  )}

  ${callout(
    "warn",
    "The three constraints that shaped everything else",
    `<strong>A 140 lb frame carrying tank-class presence.</strong> The width is hollow. Four inches per side of standoff on an internal cantilever yoke, not thicker foam &mdash; which is why the shell lands at 9.0 lb while reading two sizes larger.`,
    `<strong>Texas.</strong> A parked car interior reaches 55&ndash;75&nbsp;&deg;C, so there is no PLA anywhere in the finished suit, magnets are SH grade, and cast crystals are high-HDT urethane. See Materials.`,
    `<strong>Glasses.</strong> The helm has a hinged rear cranium so it opens to clear temple arms, rather than requiring you to take the glasses off for every single don.`
  )}

  <h3>Wearer and build context</h3>
  ${kv(DATA.wearer)}

  <h3>Still assumed &mdash; correct these if wrong</h3>
  ${kv(DATA.assumed)}

  <h3>Layer map, skin outward</h3>
  ${table(["Layer", "What it is"], DATA.layers)}
`;

PAGES.presence = () => `
  <h2 class="page-title">Presence engineering</h2>
  <p class="page-lede">How a 5'7", 140 lb frame reads as heavy infantry. Every number below is silhouette, and almost all of the added volume is air.</p>

  <h3>Proportional targets</h3>
  ${table(["Dimension", "Natural", "Built target"], DATA.presence)}
  ${note(
    "The chest-to-waist ratio is the number that does the work. Anything above about 1.35 reads as armored bulk rather than a fitted duelist, and it is cheaper to buy by cinching the waist than by widening the chest."
  )}

  ${callout(
    "good",
    "Why old football pads are the right reference",
    `Modern pads are designed to disappear. Pads from the 70s and 80s were built on a cantilever arch that stood proud of the shoulder and carried impact into the chest and back plates &mdash; which is exactly the load path this suit needs, and exactly the silhouette the brief is asking for. Harvest the geometry, not the object: a used set is a $35 fit study, not something you wear under the armor.`
  )}

  <h3>Pad geometry, translated to plate</h3>
  ${table(["Football pad part", "What it did", "What it becomes here"], DATA.padTranslation)}

  <h3>The six rules that produce apparent bulk</h3>
  <div class="cards">${DATA.bulkRules
    .map(
      ([t, d]) => `<div class="card"><h4>${esc(t)}</h4><p>${esc(d)}</p></div>`
    )
    .join("")}</div>

  <h3>Yoke build, part by part</h3>
  ${table(
    ["Part", "Spec", "Grams"],
    DATA.yokeParts.map((r) => [r[0], r[1], String(r[2])]),
    { align: ["", "", "num"] }
  )}
  ${note(
    `Total <strong>250&nbsp;g</strong> for the structure that carries both pauldrons. That is less than the pauldrons themselves, which is the whole argument for a yoke over building the width into the plates.`
  )}

  ${callout(
    "info",
    "You can defer the bracket method until after the Block 2 mockup",
    `The mockup is identical for all three fabrication routes: foamcore shelves gaffer-taped to a thrift-store backpack frame, weighted to about 145&nbsp;g per side. It produces the only two numbers that matter &mdash; the reach that actually looked right in a 20-foot photo, and whether two support points held steady over fifty steps. If it stayed steady, the printed truss wins on weight. If it wobbled and wanted a third bearing point, bent aluminum is easier to iterate because you can re-bend it in a vise.`
  )}

  ${callout(
    "bad",
    "The wobble is the failure mode to test for",
    `A cantilever holding 145&nbsp;g at 110&nbsp;mm of reach is a lever, and lever arms find every doorway, elevator and crowd. Fifty steps at walking pace, filmed from the front: if the shelf oscillates visibly, add the third bearing point before you build anything in a final material.`
  )}
`;

PAGES.coverage = () => `
  <h2 class="page-title">Full-body coverage map</h2>
  <p class="page-lede">Canon says there are no gaps, only increasingly small overlapping plates. Every zone on the body, its overlap method, and what it is made of.</p>
  ${table(["Zone", "Overlap method", "Material"], DATA.coverage)}
  ${callout(
    "warn",
    "The four walk-test failures to hunt",
    `Hamstring gap, inner-thigh flash, armpit hole, lumbar gap. Film all four from knee height and from the side under hard raking light &mdash; standing still in a mirror will not find them. The standoff yoke makes the armpit gap <em>larger</em> than a fitted pauldron would, so the axillary cluster is mandatory here rather than optional.`
  )}
`;

PAGES.joints = () => `
  <h2 class="page-title">Joint bible</h2>
  <p class="page-lede">Range of motion needed, the plate recipe that delivers it, and what is actually covering the opening when the joint is at full bend.</p>
  <div class="cards">${DATA.joints
    .map(
      (j) => `<div class="card">
        <div class="card-head"><h4>${esc(j.name)}</h4><span class="pill topaz">${esc(j.rom)}</span></div>
        <p><span class="lbl">Plate recipe</span>${esc(j.recipe)}</p>
        <p><span class="lbl">At full bend</span>${esc(j.bend)}</p>
      </div>`
    )
    .join("")}</div>
`;

PAGES.fauld = () => `
  <h2 class="page-title">Fauld &mdash; the scale kilt</h2>
  <p class="page-lede">The crotch solution, and the single biggest craftsmanship differentiator in the suit. Scales are PETG printed directly onto black organza.</p>

  <h3>Scale size gradient</h3>
  ${table(["Row", "Scale size", "Count", "Why"], DATA.scaleRows, {
    align: ["", "", "num", ""],
    totalRow: DATA.scaleRows.length - 1,
  })}
  ${note(
    "Rows shrink as they descend while the circumference grows, which is what produces flare rather than a tube. Upper rows lap over lower rows at roughly 40% overlap, all pointing down and slightly outward &mdash; never mix lap direction. Because the array is modeled in CAD, pitch and lap are identical at every scale by construction."
  )}

  <h3>Print plan</h3>
  ${table(["Parameter", "Spec"], DATA.panelPlan)}

  ${callout(
    "info",
    "PETG throughout, and the organza sets the temperature",
    `Texas resolved what would otherwise be a coin-flip: PLA+ prints 20&nbsp;&deg;C cooler and is gentler on fabric, but no PLA survives a Texas car, so every scale is PETG. That leaves one problem to manage rather than two options to weigh. PETG wants 230&ndash;245&nbsp;&deg;C and polyester organza starts suffering around 250&nbsp;&deg;C &mdash; a thin margin. Drop the nozzle 15&ndash;20&nbsp;&deg;C and slow the feed for the first post-pause layer only, and prove that setting on scrap before committing a plate.`
  )}

  ${callout(
    "good",
    "Two side effects worth keeping",
    `Rigid scales click against each other when you walk. On a dragon that would be a problem; on Shardplate it is free sound design. And because each scale is a CAD object rather than a foam cutout, you can model stone facets, a raised spine, or a recessed vein into every scale for the topaz glaze to pool in &mdash; detail simply not available in 5&nbsp;mm EVA at this size.`
  )}

  <h3>Foundation stack</h3>
  <div class="cards">
    <div class="card"><h4>Waistbelt</h4><p>1.5&nbsp;mm HDPE core inside 1" webbing with a side-release buckle, sitting on the iliac crest. This is what the kilt's weight ultimately hangs from.</p></div>
    <div class="card"><h4>Yoke</h4><p>Four-way power mesh, eight-point stitched to the belt. Organza has bias drape but almost no stretch, so the mesh still supplies the give &mdash; the fabric is a scale carrier, never the foundation.</p></div>
    <div class="card"><h4>Panels</h4><p>Sewn, not glued, onto the mesh. Seams must fall under a scale lap. The top row's roots fold into a stitched 1" grosgrain band that reaches the belt, so weight travels through webbing rather than the print bond.</p></div>
    <div class="card"><h4>Modesty shell</h4><p>2&nbsp;mm EVA and matte-black mesh behind everything. This matters more with organza than it did with foam, because a sheer substrate shows daylight the moment scales spread.</p></div>
  </div>

  ${callout(
    "warn",
    "The sitting test is the acceptance gate",
    `Sit on a backless bench with knees at 90&deg;, photographed from the front three-quarter at seated eye level. Scales spread; nothing behind them may become visible, including between the thighs. On a 28.5" inseam the cuisse-to-hem margin is only about 20&nbsp;mm, which makes this the tightest geometry in the suit.`
  )}
`;

PAGES.materials = () => {
  const shopTotal = DATA.shopping.reduce((s, r) => s + r[2], 0);
  const tierRows = DATA.budgetTiers.map((t) => [t[0], t[1], `$${t[2].toLocaleString()}`]);
  tierRows.push(["Total", "—", `$${DATA.budgetTiers.reduce((s, t) => s + t[2], 0).toLocaleString()}`]);
  return `
  <h2 class="page-title">Materials</h2>
  <p class="page-lede">Mixing filament, resin and foam is right, but it needs a rule or it becomes taste. Ask which single property dominates the part, then let that property choose.</p>

  <h3>The selection rule</h3>
  ${table(["When this dominates", "Use", "Because", "Watch out for"], DATA.materialLogic)}
  ${note(
    "Foam buys volume, filament buys geometry and threads, resin buys surface and optics. If a part needs two of those, it is not one part &mdash; it is a foam body with a printed skeleton, or a printed frame with a cast face. Split it at the seam."
  )}

  ${callout(
    "bad",
    "Texas moves the thermal ceiling from a footnote to a design driver",
    `Keeping the suit indoors solves storage but not transport, and transport is the exposure that matters. A Texas car interior reaches 55&ndash;75&nbsp;&deg;C, and the trunk is not air-conditioned even when the cabin is. There is no version of this build where the suit does not spend twenty minutes being loaded and three hours in a vehicle, so the material plan has to survive that window rather than depend on avoiding it.`
  )}

  <h3>Texas substitutions</h3>
  ${table(
    ["Part", "Was", "Now", "Why"],
    DATA.texasSubs.map((r) => [r[0], r[1], r[2], r[3]]),
    { rowClass: DATA.texasSubs.map((r) => r[4]) }
  )}
  ${note(
    "Net effect on the shell: plus 72&nbsp;g for the ASA helm, minus 20&nbsp;g from the ASA yoke. Two rows are marked because they are the ones nobody plans for &mdash; magnet grade quietly ruins closures over a season, and the power bank one is a fire risk rather than a durability risk."
  )}

  ${callout(
    "warn",
    "ASA needs an enclosed, vented printer",
    `ASA warps badly in open air and releases styrene. If you do not have an enclosure, the fallback for every ASA part is PETG &mdash; still well clear of PLA, still adequate for a shaded trunk, about 20% heavier on the helm. This is the one substitution that depends on equipment you may not own.`
  )}

  <h3>Hybrid stacks &mdash; what each part is actually made of</h3>
  ${table(["Part", "Structure", "Volume and skin", "Detail and finish"], DATA.hybridStacks)}

  ${callout(
    "good",
    "Printed edge trim is the highest-value thing mixing unlocks",
    `Foam edges stay slightly soft no matter how well you bevel them, and in a 20-foot photo that softness is what reads as &ldquo;painted foam.&rdquo; A 1.2 &times; 6&nbsp;mm PETG strip printed to follow each specific arc gives a hard, crisp, sandable line foam cannot hold. Apply only where a judge's eye lands: cuirass hem and neckline, outer pauldron lames, fauld hip plates, greave and vambrace openings, plus rim rings on the four cops.`,
    `<strong>Tradeoff:</strong> about 100&nbsp;g, which is the difference between foam and forged metal in every photograph. It is the best weight-for-points trade in the build.`
  )}

  ${callout(
    "warn",
    "Three materials means three primer paths, one topcoat",
    `This is where mixed-material builds usually fail visually. EVA needs a flexible seal, PETG needs scuff plus adhesion promoter, resin needs degrease plus filler primer. Three preparations converging on one base coat and one gloss level &mdash; skip it and the suit reads as three suits bolted together, because differing substrate absorption shows as sheen mismatch under hall lighting even when the color matches. Spray a three-substrate test card and confirm before anything touches a real part.`
  )}

  <h3>Subassembly matrix</h3>
  ${table(["Subassembly", "Primary", "Secondary", "Will NOT use, and why"], DATA.matrix)}

  <h3>Budget in tiers</h3>
  ${table(["Tier", "What it buys", "USD"], tierRows, {
    align: ["", "", "num"],
    rowClass: DATA.budgetTiers.map((t) => t[3]),
    totalRow: tierRows.length - 1,
  })}
  ${note(
    "Thermal hardening is the tier not to cut in Texas &mdash; it is insurance on the other $1,985. Cooling is the tier that protects you rather than the costume."
  )}

  <h3>Spend by category</h3>
  ${barChart(DATA.budgetByCategory, "")}

  <h3>Shopping list</h3>
  ${table(
    ["Item", "Quantity", "Estimate"],
    DATA.shopping.map((r) => [r[0], r[1], `$${r[2]}`]).concat([["Total", "", `$${shopTotal.toLocaleString()}`]]),
    { align: ["", "", "num"], totalRow: DATA.shopping.length }
  )}
`;
};

PAGES.procurement = () => {
  const cfg = loadBuilder();
  const week = Math.min(72, Math.max(1, cfg.week || 1));
  const blocks = blocksForWeek(week);
  const items = procurementItemsForWeek(week);
  const weekSpend = items.reduce((s, r) => s + r.usd, 0);
  const cumulative = procurementSpendThroughWeek(week);
  const shopTotal = DATA.shopping.reduce((s, r) => s + r[2], 0);
  const cal = weekCalendarDate(week, cfg.startDate);
  const blockLabel =
    blocks.length === 0
      ? "Outside the build calendar"
      : blocks.map((b) => `Block ${b.block}`).join(" + ");

  const blockOverview = DATA.procurementByBlock.map((b) => {
    const blockItems = b.items
      .map((name) => {
        const shop = shopByName().get(name);
        return shop ? [name, shop[1], `$${shop[2]}`] : [name, "—", "—"];
      })
      .concat([
        [
          "Block subtotal",
          "",
          `$${b.items.reduce((s, name) => s + (shopByName().get(name)?.[2] || 0), 0)}`,
        ],
      ]);
    return `<div class="phase${b.block === (blocks[0]?.block || 0) ? " open" : ""}" data-proc-block="${b.block}">
      <div class="phase-head">
        <span class="caret">▶</span>
        <div class="phase-title">
          <h4>Block ${b.block} — ${esc(b.weeks)}</h4>
          <span class="weeks">${b.items.length} items · ${esc(b.weeks)}</span>
        </div>
      </div>
      <div class="phase-body">
        <p class="phase-note">${esc(b.note)}</p>
        ${table(["Item", "Quantity", "Estimate"], blockItems, {
          align: ["", "", "num"],
          totalRow: blockItems.length - 1,
        })}
      </div>
    </div>`;
  }).join("");

  const itemRows = items.map((r) => [
    r.name,
    r.qty,
    r.usd ? `$${r.usd}` : "—",
    `Block ${r.block}`,
  ]);
  if (itemRows.length) {
    itemRows.push(["This week", "", `$${weekSpend}`, ""]);
  }

  const spendByBlock = DATA.procurementByBlock.map((b) => [
    `Block ${b.block} (${b.weeks})`,
    b.items.reduce((s, name) => s + (shopByName().get(name)?.[2] || 0), 0),
  ]);

  return `
  <h2 class="page-title">Weekly materials</h2>
  <p class="page-lede">What to buy and when — mapped to the nine build blocks. Pick a week to see that block's shopping list, cumulative spend, and optional calendar dates if you set a start date.</p>

  ${statRow([
    { value: `Week ${week}`, label: blockLabel, tone: blocks.length ? "info" : "" },
    { value: `$${weekSpend.toLocaleString()}`, label: "Active block materials", tone: weekSpend ? "warn" : "" },
    { value: `$${cumulative.toLocaleString()}`, label: "Cumulative through this week", tone: "" },
    { value: `$${shopTotal.toLocaleString()}`, label: "Full project total", tone: "good" },
  ])}

  ${callout(
    "info",
    "How to read this page",
    `Items appear in the week their block <em>starts</em>, so you have stock on hand before the steps that need it. Blocks 4 and 5 overlap (weeks 27–34), so those weeks show a merged list from both blocks.`,
    `Some materials appear in more than one block when trials and production are separate buys — organza and PETG in Block 3 for scorch trials, then again in Block 6 for the production run. The cumulative total counts each shopping-line item once.`
  )}

  <h3>Week selector</h3>
  <div class="proc-controls">
    <div class="proc-row">
      <label for="proc-week">Build week</label>
      <input type="range" id="proc-week" min="1" max="72" value="${week}">
      <output id="proc-week-out" for="proc-week">Week ${week}${cal ? ` · ~${cal}` : ""}</output>
    </div>
    <div class="proc-row">
      <label for="proc-start">Start date <span class="fine">(optional)</span></label>
      <input type="date" id="proc-start" value="${esc(cfg.startDate || "")}">
      <button class="btn" data-proc-act="clear-date">Clear</button>
    </div>
    <div class="proc-row proc-actions">
      <button class="btn" data-proc-act="prev">← Prev week</button>
      <button class="btn" data-proc-act="next">Next week →</button>
      <span class="grow"></span>
      <button class="btn ${cfg.view === "week" ? "primary" : ""}" data-proc-view="week">By week</button>
      <button class="btn ${cfg.view === "blocks" ? "primary" : ""}" data-proc-view="blocks">All blocks</button>
    </div>
  </div>

  ${
    cfg.view === "blocks"
      ? `<h3>Procurement by block</h3>
         <p class="note">Full schedule — buy everything in a block before its first week. See also the flat list on <a href="#materials">Materials</a> and the build steps on <a href="#build">Build order</a>.</p>
         ${blockOverview}`
      : `<h3>Week ${week}${cal ? ` · ${esc(cal)}` : ""}</h3>
         ${
           blocks.length
             ? `<p class="note">${blocks
                 .map((b) => `<strong>${esc(b.weeks)}</strong> — ${esc(b.note)}`)
                 .join("<br>")}</p>`
             : `<p class="note">Week ${week} is outside the 72-week build calendar (64 weeks plus 8 float).</p>`
         }
         ${
           itemRows.length
             ? table(["Item", "Quantity", "Estimate", "Block"], itemRows, {
                 align: ["", "", "num", ""],
                 totalRow: itemRows.length - 1,
                 rowClass: items.map((r) => (r.missing ? "bad" : "")),
               })
             : `<div class="empty">No procurement items scheduled for this week.</div>`
         }`
  }

  <h3>Spend by block</h3>
  ${barChart(spendByBlock, "")}
  ${note(
    `Thermal hardening, cooling, and the fog module are included in the block totals above. Cumulative through week ${week}: <strong>$${cumulative.toLocaleString()}</strong> of <strong>$${shopTotal.toLocaleString()}</strong> total.`
  )}
`;
};

PAGES.joinery = () => `
  <h2 class="page-title">Joinery</h2>
  <p class="page-lede">How every class of part attaches to every other class. Fourteen interfaces, each with a spec and an explicit never. If a helper is unsure how something attaches, the answer is on this page.</p>

  ${callout(
    "info",
    "One principle covers most of it",
    `<strong>Adhesive positions, fasteners carry.</strong> Every load path in this suit ends in webbing, a rivet, a screw into a heat-set insert, or stitching. Glue exists to hold parts still while the mechanical joint does the work. Texas adds a second reason: contact cement creeps at elevated temperature.`
  )}

  <div class="cards">${DATA.joinery
    .map(
      (j) => `<div class="card">
        <h4>${esc(j.id)}</h4>
        <p><span class="lbl">Method</span><strong>${esc(j.method)}</strong></p>
        <p><span class="lbl">Spec</span>${esc(j.spec)}</p>
        <p class="never"><span class="lbl">Never</span>${esc(j.never)}</p>
      </div>`
    )
    .join("")}</div>

  <h3>Standardize the hardware</h3>
  ${note(
    "Pick one size of each and never deviate: M3 socket screws with brass heat-set inserts, one rivet diameter, 6 &times; 3&nbsp;mm N45SH magnets, 1\" webbing, 1.5&nbsp;mm HDPE for washers and backers. One hex driver opens the entire suit, and every spare is interchangeable."
  )}
`;

PAGES.build = () => {
  const total = allStepIds().length;
  const done = allStepIds().filter((id) => progress[id]).length;
  return `
  <h2 class="page-title">Build order</h2>
  <p class="page-lede">Nine blocks over 64 weeks, plus 8 weeks of declared float. Check steps off as you go &mdash; progress is saved in this browser, so each person tracking their own copy gets their own state.</p>

  <h3>Assembly architecture &mdash; the six units</h3>
  <p>Everything on this page exists to produce six objects. The suit is not a hundred parts you attach to yourself; it is six assemblies that each go on in one motion, in a fixed order, and each one lands its weight somewhere deliberate. Read this before the blocks &mdash; it is the reason the blocks are sequenced the way they are.</p>

  ${table(
    ["Unit", "What's in it", "How it goes on", "Weight lands on", "g"],
    DATA.assemblyUnits.map((u) => [u.id, u.holds, u.how, u.carries, u.grams.toLocaleString()]),
    { align: ["", "", "", "", "num"] }
  )}

  ${callout(
    "good",
    "The load path checks out",
    `Legs suspend from the hip belt, the torso and everything clipped to it rests on the yoke, and the head carries only the helm. Run the numbers against that split and it lands at <strong>4.4 lb on the shoulders, 2.2 lb on the hips, 1.7 lb on the head and neck</strong>, with the rest on feet and hands. That shoulder figure is a light day pack, and it is the number that decides whether hour eleven is fine or miserable.`,
    `The single thing that breaks it is tensioning the leg suspenders. Do that and the 2.2 lb on your hips migrates onto the same trapezius already carrying 4.4 lb, and you have built a 6.6 lb yoke load with no way to shed it without undressing.`
  )}

  ${barChart(DATA.loadPath, " g")}

  <h3>Six rules that fall out of this architecture</h3>
  ${table(["Rule", "Why"], DATA.architectureRules)}

  ${note(
    "Attaching the kilt to the cuirass is a good structural call &mdash; it puts the fauld's 460 g onto the yoke shelf instead of dragging on a separate belt, and it kills the gap between cuirass hem and kilt top that is otherwise the hardest seam in the suit to hide. It just has to stay a curtain rather than becoming a tube."
  )}

  <h3>The blocks</h3>

  ${linearPanel()}

  <div class="overall">
    <div class="top"><strong>Overall progress</strong><span id="ov-frac">${done} of ${total} steps · ${Math.round(
    (done / total) * 100
  )}%</span></div>
    <div class="bar"><i id="ov-bar" style="width:${(done / total) * 100}%"></i></div>
  </div>

  <div class="toolbar">
    <button class="btn" data-act="expand">Expand all</button>
    <button class="btn" data-act="collapse">Collapse all</button>
    <span class="grow"></span>
    <button class="btn" data-act="export">Export progress</button>
    <button class="btn" data-act="import">Import progress</button>
    <button class="btn" data-act="reset">Reset</button>
  </div>

  ${DATA.phases
    .map((p, pi) => {
      const st = phaseStats(p);
      const untouched = allStepIds().every((id) => !progress[id]);
      const open = (untouched && pi === 0) || (st.done > 0 && st.done < st.total) ? " open" : "";
      const doneCls = st.done === st.total ? " done" : "";
      return `<div class="phase${open}${doneCls}" data-phase="${pi}">
        <div class="phase-head">
          <span class="caret">▶</span>
          <div class="phase-title">
            <h4>${esc(p.phase)}</h4>
            <span class="weeks">${esc(p.weeks)}</span>
          </div>
          <div class="phase-prog">
            <span class="frac">${st.done}/${st.total}</span>
            <div class="bar"><i style="width:${st.pct}%"></i></div>
          </div>
        </div>
        <div class="phase-body">
          <p class="phase-note">${esc(p.note)}</p>
          ${p.steps
            .map(
              ([id, text]) => `<div class="step">
                <input type="checkbox" id="${id}" data-step="${id}" ${progress[id] ? "checked" : ""}>
                <span class="sid">${id}</span>
                <label for="${id}">${esc(text)}</label>
                <span class="acts">
                  <button class="btn" data-linear="${id}" title="Copy as a Linear issue">Linear</button>
                </span>
              </div>`
            )
            .join("")}
          <div class="toolbar" style="margin:14px 0 0">
            <button class="btn" data-linear-block="${pi}">Copy whole block for Linear</button>
          </div>
        </div>
      </div>`;
    })
    .join("")}
`;
};

PAGES.crew = () => `
  <h2 class="page-title">Crew &mdash; delegating without losing quality</h2>
  <p class="page-lede">Every task here has a jig, a golden sample and an acceptance test, so a friend can work while you are out of the room and you can tell at a glance whether it passed.</p>

  ${callout(
    "info",
    "The golden sample rule",
    `Make one perfect example of every repeated part and hang it at the station where that part gets made. Helpers compare their work to the golden sample, not to a description. A part that does not match goes in a bin labelled QUESTION rather than into the build &mdash; never into the scrap pile, because the reason it failed is information.`
  )}

  <h3>Delegatable tasks</h3>
  ${table(["Task", "Batch", "Jig or tooling", "Acceptance test"], DATA.crewTasks)}

  <h3>Never delegate</h3>
  ${table(["Task", "Why it stays with you"], DATA.neverDelegate, {
    rowClass: DATA.neverDelegate.map(() => "bad"),
  })}

  ${callout(
    "warn",
    "The tooling block is what makes this possible",
    `Block 3 costs eight weeks and produces almost nothing you can wear. It buys every jig, buck, mold, golden sample and cut list &mdash; which is what converts a judgment task into a repeatable one. On a fourteen-month schedule that trade is clearly worth it; on a three-month schedule it would not be.`
  )}
`;

PAGES.weight = () => {
  const shell = DATA.weights.reduce((s, r) => s + r[1], 0);
  const extras = DATA.weightExtras.reduce((s, r) => s + r[1], 0);
  const allUp = shell + extras;
  const lb = (g) => (g / 453.592).toFixed(1);
  const rows = DATA.weights.map((r) => [r[0], String(r[1])]);
  rows.push(["Armor shell, no boots", String(shell)]);
  DATA.weightExtras.forEach((r) => rows.push([r[0], String(r[1])]));
  rows.push(["All-up worn kit", String(allUp)]);
  return `
  <h2 class="page-title">Weight budget</h2>
  <p class="page-lede">Target was 8 to 10 lb of shell excluding boots. The plan lands at ${lb(
    shell
  )} lb despite a much larger silhouette, because the added bulk is air rather than material.</p>

  ${statRow([
    { value: `${shell.toLocaleString()} g`, label: "Armor shell, no boots", tone: "good" },
    { value: `${lb(shell)} lb`, label: "Shell in pounds", tone: "good" },
    { value: `${lb(allUp)} lb`, label: "All-up worn kit", tone: "" },
    { value: "8.3%", label: "Of a 140 lb bodyweight", tone: "warn" },
  ])}

  ${callout(
    "bad",
    "The honest number for a hot Texas day is 15.6 lb, not 11.7",
    `The 11.7&nbsp;lb figure is the suit. It is not what you carry in August. Add a full 1&nbsp;L bladder at 1,000&nbsp;g and a set of PCM packs at about 800&nbsp;g and the real load stepping outside is roughly 7,100&nbsp;g &mdash; 15.6&nbsp;lb, or 11.2% of your bodyweight.`,
    `Two habits pull it back. Water you already drank weighs nothing, so front-load before donning and carry 0.5&nbsp;L rather than 1&nbsp;L, refilling at the hip port &mdash; that alone is 500&nbsp;g. And carry one PCM set on your body, never a spare. Those two get you to 14.5&nbsp;lb starting a block and about 13.5&nbsp;lb finishing it, which is the range the mobility plan was built around.`
  )}

  <h3>By piece</h3>
  ${table(["Piece", "Grams"], rows, {
    align: ["", "num"],
    rowClass: rows.map((r, i) =>
      r[0] === "Armor shell, no boots" || r[0] === "All-up worn kit" ? "good" : ""
    ),
  })}

  <h3>By region</h3>
  ${barChart(DATA.weightByRegion, " g")}

  ${callout(
    "good",
    "What printing on organza saved",
    `Roughly nothing against the published number, and a real amount against what that number would honestly have been. Two hundred hand-cut EVA scales weigh about 105&nbsp;g &mdash; but the 400 Chicago screws and washers holding them to grosgrain bands add another 200&nbsp;g, so the true EVA figure was closer to 600&nbsp;g. Printed PETG is five times denser per unit volume but a fifth the thickness, and needs no fasteners at all. The same logic dropped the hamstring lames from 190&nbsp;g to 120&nbsp;g.`
  )}
`;
};

PAGES.logistics = () => `
  <h2 class="page-title">Logistics</h2>
  <p class="page-lede">Donning, the Texas heat protocol, hydration, and what breaks first. Priority one in this build was always &ldquo;wearable all day&rdquo; &mdash; in Texas that stops being a comfort target and becomes a safety one.</p>

  <h3>Donning sequence &mdash; 15 minutes, one helper</h3>
  ${table(["Step", "Who", "Time"], DATA.donning, { align: ["", "", "num"] })}
  ${note(
    'Legs first, while you can still bend, and boots before anything closes over the ankle. From there it is one unit per step &mdash; see <a href="#build">the six units</a> on the build page for what each one contains and where its weight goes.'
  )}

  <h3>Texas heat protocol</h3>
  ${table(["Situation", "Rule"], DATA.heatProtocol.map((r) => [r[0], r[1]]), {
    rowClass: DATA.heatProtocol.map((r) => r[2]),
  })}
  ${note(
    "Two rows are marked. Panic doffing is the one that could matter medically, so it gets rehearsed on a timer like any other safety drill. Home storage is marked because &ldquo;indoors&rdquo; and &ldquo;not in the garage&rdquo; are different claims."
  )}

  ${callout(
    "good",
    "The cheapest cooling upgrade is the schedule",
    `Nothing in the shopping list competes with shooting at golden hour instead of noon. A 7 p.m. Texas photoshoot runs 15&ndash;20&nbsp;&deg;F cooler, the light is dramatically better for metallics and seam glow, and it costs zero dollars and zero grams. Budget the expensive cooling hardware for the con floor and the masquerade queue, which you cannot reschedule.`
  )}

  <h3>Hydration and the bathroom loop</h3>
  ${callout(
    "info",
    "The counterintuitive part first",
    `Inside a suit this insulated, most of what you drink leaves as sweat rather than urine, so at a given intake you will need the bathroom <em>less</em> often than in street clothes, not more. The real failure mode is the opposite of the one people worry about: they under-drink to avoid the hassle, hit a headache around hour six, and leave early. The three-minute bathroom protocol exists precisely so drinking properly is affordable.`
  )}
  ${table(["Scenario", "Sweat rate", "Intake plan", "Expected bathroom load"], DATA.fluidScenarios)}

  <h3>Electronics zones</h3>
  ${table(["Zone", "What it drives", "Connectors"], DATA.zones)}

  <h3>What breaks first, in order</h3>
  ${table(["Component", "Why, and what to carry"], DATA.failureOrder, {
    rowClass: DATA.failureOrder.map((_, i) => (i < 2 ? "warn" : "")),
  })}
`;

PAGES.donot = () => {
  const groups = [
    ["brief", "Specific to this brief — Stoneward, tank presence, a short frame, glasses"],
    ["texas", "Texas and thermal"],
    ["organza", "Printed scales on organza"],
    ["", "General armor discipline"],
  ];
  return `
  <h2 class="page-title">Do not</h2>
  <p class="page-lede">Every entry here is a mistake that costs real time or real money, grouped so you can find the relevant ones quickly.</p>
  ${groups
    .map(([key, title]) => {
      const rows = DATA.doNot.filter((r) => r[2] === key);
      if (!rows.length) return "";
      return `<h3>${esc(title)}</h3>${table(
        ["Do not", "Because"],
        rows.map((r) => [r[0], r[1]]),
        { rowClass: rows.map(() => (key === "texas" ? "bad" : key ? "warn" : "")) }
      )}`;
    })
    .join("")}
`;
};

PAGES.renders = () => `
  <h2 class="page-title">Render prompts</h2>
  <p class="page-lede">Paste-ready prompts for Gemini (Nano Banana). Generate the hero shot first, then attach that image as a reference for every other prompt &mdash; the model is strong at holding a design consistent when it can see it, and much weaker at re-deriving it from words.</p>

  <div class="prompt-block">
    <div class="prompt-head">
      <h4>Style block &mdash; append to every prompt</h4>
      <button class="btn primary" data-copy="style">Copy</button>
    </div>
    <pre class="prompt" id="p-style">${esc(DATA.renderStyleBlock)}</pre>
  </div>

  ${DATA.renderPrompts
    .map(
      (p) => `<div class="prompt-block">
        <div class="prompt-head">
          <h4>${esc(p.title)}</h4>
          <button class="btn primary" data-copy="${p.id}">Copy</button>
        </div>
        ${note(esc(p.note))}
        <pre class="prompt" id="p-${p.id}">${esc(p.body)}</pre>
      </div>`
    )
    .join("")}

  <h3>What it will get wrong</h3>
  ${table(["Failure", "The correction that works"], DATA.renderNotes)}
`;

PAGES.images = () => `
  <h2 class="page-title">Reference images</h2>
  <p class="page-lede">Renders, reference art, work-in-progress photos and anything else worth looking at together.</p>

  ${callout(
    "info",
    "How to add an image",
    `Drop the file into the <code>images/</code> folder in the repository, add an entry to <code>images/manifest.json</code>, then commit and push. GitHub Pages redeploys in about a minute and it appears here for everyone.`,
    `Each entry looks like <code>{ "file": "hero-v1.png", "group": "Renders", "caption": "First hero render, shoulders still too narrow" }</code>. Images are grouped by the <code>group</code> field in the order the groups first appear. Click any image to open it full size.`
  )}

  <div id="gallery"><div class="empty">Loading images…</div></div>
`;

/* ------------------------------------------------------------------ nav */

const NAV = [
  ["The build", [
    ["overview", "A", "Overview"],
    ["presence", "A2", "Presence"],
    ["coverage", "B", "Coverage"],
    ["joints", "C", "Joints"],
    ["fauld", "D", "Fauld"],
  ]],
  ["Making it", [
    ["materials", "E", "Materials"],
    ["procurement", "E3", "Weekly materials"],
    ["joinery", "E2", "Joinery"],
    ["build", "G", "Build order"],
    ["crew", "G2", "Crew"],
  ]],
  ["Living with it", [
    ["weight", "H", "Weight"],
    ["logistics", "I", "Logistics"],
    ["donot", "K", "Do not"],
  ]],
  ["Visual", [
    ["renders", "R", "Render prompts"],
    ["images", "R2", "Images"],
  ]],
];

function renderNav(active) {
  return NAV.map(
    ([group, items]) =>
      `<div class="nav-group">${esc(group)}</div>` +
      items
        .map(
          ([id, key, label]) =>
            `<a href="#${id}" class="${id === active ? "active" : ""}"><span class="key">${key}</span>${esc(
              label
            )}</a>`
        )
        .join("")
  ).join("");
}

/* -------------------------------------------------------------- gallery */

async function loadGallery() {
  const el = $("#gallery");
  if (!el) return;
  try {
    const res = await fetch("images/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no manifest");
    const items = await res.json();
    if (!items.length) throw new Error("empty");

    const groups = [];
    for (const item of items) {
      const name = item.group || "Ungrouped";
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, items: [] }));
      g.items.push(item);
    }

    el.innerHTML = groups
      .map(
        (g) => `<h3>${esc(g.name)}</h3><div class="gallery">${g.items
          .map(
            (i) =>
              `<figure class="shot">
                 <a href="images/${esc(i.file)}" target="_blank" rel="noopener">
                   <img loading="lazy" src="images/${esc(i.file)}" alt="${esc(i.caption || i.file)}">
                 </a>
                 <figcaption class="cap">${esc(i.caption || i.file)}</figcaption>
               </figure>`
          )
          .join("")}</div>`
      )
      .join("");
  } catch {
    el.innerHTML = `<div class="empty">No images yet. Add files to <code>images/</code> and list them in <code>images/manifest.json</code>.</div>`;
  }
}

/* --------------------------------------------------------------- router */

function route() {
  const id = (location.hash || "#overview").slice(1);
  const page = PAGES[id] ? id : "overview";
  $("#nav").innerHTML = renderNav(page);
  $("#main").innerHTML = PAGES[page]() + footerHtml();
  window.scrollTo(0, 0);
  $(".sidebar").classList.remove("open");
  $(".scrim").classList.remove("show");
  if (page === "images") loadGallery();
  if (page === "build") wireBuild();
  if (page === "procurement") wireProcurement();
  if (page === "renders") wireRenders();
}

const footerHtml = () =>
  `<footer>Stoneward Shardplate build bible · ${
    linearConnected() ? "progress synced with Linear" : "progress stored in this browser only"
  } · <a href="#procurement">weekly materials</a> · <a href="#build">build order</a> · <a href="#donot">do not</a></footer>`;

/* ---------------------------------------------------------------- wiring */

function refreshProgressUI() {
  const total = allStepIds().length;
  const done = allStepIds().filter((id) => progress[id]).length;
  const ovBar = $("#ov-bar");
  const ovFrac = $("#ov-frac");
  if (ovBar) ovBar.style.width = `${(done / total) * 100}%`;
  if (ovFrac) ovFrac.textContent = `${done} of ${total} steps · ${Math.round((done / total) * 100)}%`;

  $$(".phase").forEach((el) => {
    const p = DATA.phases[+el.dataset.phase];
    const st = phaseStats(p);
    $(".frac", el).textContent = `${st.done}/${st.total}`;
    $(".phase-prog .bar i", el).style.width = `${st.pct}%`;
    el.classList.toggle("done", st.done === st.total);
  });
}

function wireBuild() {
  $$(".phase-head").forEach((h) =>
    h.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      h.parentElement.classList.toggle("open");
    })
  );

  $$('input[data-step]').forEach((cb) =>
    cb.addEventListener("change", () => setStep(cb.dataset.step, cb.checked, cb))
  );

  $$("[data-linear]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.dataset.linear;
      for (const p of DATA.phases) {
        const s = p.steps.find((x) => x[0] === id);
        if (s) {
          sendToLinear(s[1], `Shardplate · ${p.phase} (${p.weeks})\n\nStep ${id}\n\n${p.note}`);
          return;
        }
      }
    })
  );

  $$("[data-linear-block]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = DATA.phases[+b.dataset.linearBlock];
      const body = p.steps.map((s) => `- [ ] ${s[1]}`).join("\n");
      copy(`${p.phase}\n${p.weeks}\n\n${p.note}\n\n${body}`, "Block copied — paste into Linear");
    })
  );

  const acts = {
    expand: () => $$(".phase").forEach((p) => p.classList.add("open")),
    collapse: () => $$(".phase").forEach((p) => p.classList.remove("open")),
    export: () => {
      const blob = new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "shardplate-progress.json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Progress exported");
    },
    import: () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json";
      inp.onchange = async () => {
        try {
          progress = JSON.parse(await inp.files[0].text());
          save(STORE_PROGRESS, progress);
          route();
          toast("Progress imported");
        } catch {
          toast("That file could not be read");
        }
      };
      inp.click();
    },
    reset: () => {
      if (linearConnected()) {
        toast("Linear is the source of truth — reopen the issues there instead");
        return;
      }
      if (!confirm("Clear all checked steps in this browser?")) return;
      progress = {};
      save(STORE_PROGRESS, progress);
      route();
      toast("Progress cleared");
    },
    "linear-connect": async () => {
      const key = ($("#lk").value || "").trim();
      if (!key) return toast("Paste a Linear API key first");
      setLinearKey(key);
      toast("Checking that key…");
      await linearRefresh();
      if (!linearConnected()) setLinearKey("");
      else toast("Connected — progress now comes from Linear");
    },
    "linear-sync": () => linearRefresh("Synced with Linear"),
    "linear-disconnect": async () => {
      setLinearKey("");
      Linear.viewer = null;
      Linear.remote = {};
      await linearRefresh("Key removed — tracking locally again");
    },
  };
  $$("[data-act]").forEach((b) => b.addEventListener("click", () => acts[b.dataset.act]()));
}

function wireRenders() {
  $$("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.copy;
      const body = $(`#p-${id}`).textContent;
      const text = id === "style" ? body : `${body}\n\n${DATA.renderStyleBlock}`;
      copy(text, id === "style" ? "Style block copied" : "Prompt copied, style block included");
    })
  );
}

function wireProcurement() {
  const cfg = loadBuilder();
  const rerender = (patch) => {
    saveBuilder({ ...loadBuilder(), ...patch });
    const y = window.scrollY;
    route();
    window.scrollTo(0, y);
  };

  $$(".phase-head", $("#main")).forEach((h) =>
    h.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      h.parentElement.classList.toggle("open");
    })
  );

  const weekInput = $("#proc-week");
  const weekOut = $("#proc-week-out");
  if (weekInput) {
    const syncOut = () => {
      const w = +weekInput.value;
      const cal = weekCalendarDate(w, ($("#proc-start")?.value || cfg.startDate || "").trim());
      weekOut.textContent = `Week ${w}${cal ? ` · ~${cal}` : ""}`;
    };
    weekInput.addEventListener("input", syncOut);
    weekInput.addEventListener("change", () => rerender({ week: +weekInput.value }));
    syncOut();
  }

  const startInput = $("#proc-start");
  if (startInput) {
    startInput.addEventListener("change", () => rerender({ startDate: startInput.value }));
  }

  $$("[data-proc-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const cur = loadBuilder();
      const w = cur.week || 1;
      if (b.dataset.procAct === "prev") rerender({ week: Math.max(1, w - 1) });
      if (b.dataset.procAct === "next") rerender({ week: Math.min(72, w + 1) });
      if (b.dataset.procAct === "clear-date") rerender({ startDate: "" });
    })
  );

  $$("[data-proc-view]").forEach((b) =>
    b.addEventListener("click", () => rerender({ view: b.dataset.procView }))
  );
}

/* ------------------------------------------------------------------ boot */

function boot() {
  document.body.innerHTML = `
    <button class="menu-btn" aria-label="Menu">☰</button>
    <div class="scrim"></div>
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <h1>Stoneward Shardplate</h1>
          <p>Build bible &amp; reference · living Radiant Plate</p>
        </div>
        <nav class="nav" id="nav"></nav>
      </aside>
      <main class="main" id="main"></main>
    </div>`;

  $(".menu-btn").addEventListener("click", () => {
    $(".sidebar").classList.toggle("open");
    $(".scrim").classList.toggle("show");
  });
  $(".scrim").addEventListener("click", () => {
    $(".sidebar").classList.remove("open");
    $(".scrim").classList.remove("show");
  });

  window.addEventListener("hashchange", route);
  route();

  /* Paint from cache first, then reconcile with Linear — a slow or failing
     API call must never leave the page blank. */
  linearInit().then(() => {
    if (linearConnected()) {
      progress = { ...Linear.remote };
      save(STORE_PROGRESS, progress);
    }
    if (Linear.status !== "off") {
      const y = window.scrollY;
      route();
      window.scrollTo(0, y);
    }
  });
}

document.addEventListener("DOMContentLoaded", boot);
