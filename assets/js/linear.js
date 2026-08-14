/* Linear sync — personal API key, browser-direct GraphQL, no backend.
   Linear serves permissive CORS to this origin and allows POST with an
   Authorization header, so the static site can talk to the API itself. */

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const STORE_LINEAR_KEY = "shardplate.linearkey.v1";

const Linear = {
  map: null, // linear-map.json, once fetched
  viewer: null, // { id, name } when a key is verified
  issues: {}, // stepId -> { uuid, identifier }, learned on each pull
  remote: {}, // stepId -> true when the issue is in a completed state
  status: "off", // off | unseeded | error | ready
  error: "",
  warning: "",
};

const linearKey = () => {
  try {
    return localStorage.getItem(STORE_LINEAR_KEY) || "";
  } catch {
    return "";
  }
};

const setLinearKey = (k) => {
  try {
    if (k) localStorage.setItem(STORE_LINEAR_KEY, k);
    else localStorage.removeItem(STORE_LINEAR_KEY);
  } catch {
    /* storage blocked — the session stays unconnected, which is handled */
  }
};

async function linearGql(query, variables) {
  const key = linearKey();
  if (!key) throw new Error("No Linear API key is set");

  let res;
  try {
    res = await fetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error("Could not reach Linear — check your connection");
  }

  if (res.status === 401 || res.status === 403) throw new Error("That API key was rejected by Linear");

  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Linear returned ${res.status} with no readable body`);

  if (json.errors && json.errors.length) {
    const e = json.errors[0];
    const code = e.extensions && e.extensions.code;
    if (code === "RATELIMITED") throw new Error("Linear rate limit reached — wait a minute and retry");
    if (code === "AUTHENTICATION_ERROR") throw new Error("That API key was rejected by Linear");
    throw new Error(e.message || "Linear rejected the request");
  }
  return json.data;
}

async function linearLoadMap() {
  try {
    const res = await fetch("assets/js/linear-map.json", { cache: "no-store" });
    if (!res.ok) return null;
    const m = await res.json();
    return m && m.steps && Object.keys(m.steps).length ? m : null;
  } catch {
    return null;
  }
}

const linearVerify = async () => (await linearGql(`query { viewer { id name } }`)).viewer;

/* One query covers the whole build — 75 issues is well inside both the
   250-node page and Linear's per-query complexity ceiling.

   The map stores human-readable identifiers (CRE-42) because those are what
   you can eyeball against Linear, but mutations need the UUID. Reading the
   project hands back both, so each pull re-learns the UUIDs and the mapping
   survives issues being moved or renamed. */
async function linearPull() {
  const data = await linearGql(
    `query($project:String!) {
      project(id: $project) {
        issues(first: 250) {
          nodes { id identifier state { type } }
        }
      }
    }`,
    { project: Linear.map.project.id }
  );

  const byIdentifier = {};
  for (const n of data.project.issues.nodes) byIdentifier[n.identifier] = n;

  Linear.issues = {};
  const remote = {};
  for (const [stepId, identifier] of Object.entries(Linear.map.steps)) {
    const node = byIdentifier[identifier];
    if (!node) continue;
    Linear.issues[stepId] = { uuid: node.id, identifier };
    if (node.state && node.state.type === "completed") remote[stepId] = true;
  }

  const found = Object.keys(Linear.issues).length;
  const expected = Object.keys(Linear.map.steps).length;
  if (found === 0) throw new Error("No mapped issues found in that Linear project");
  if (found < expected) Linear.warning = `${expected - found} of ${expected} steps are missing from Linear`;

  return remote;
}

async function linearPush(stepId, done) {
  const issue = Linear.issues[stepId];
  if (!issue) throw new Error(`Step ${stepId} has no Linear issue mapped to it`);

  const stateId = done ? Linear.map.states.done : Linear.map.states.todo;
  const data = await linearGql(
    `mutation($id:String!, $stateId:String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issue.uuid, stateId }
  );
  if (!data.issueUpdate || !data.issueUpdate.success) throw new Error("Linear did not accept the update");
}

/* Resolves the connection once at boot. Never throws — a failure here has to
   degrade into local-only tracking rather than taking the page down. */
async function linearInit() {
  Linear.map = await linearLoadMap();
  if (!Linear.map) {
    Linear.status = "unseeded";
    return;
  }
  if (!linearKey()) {
    Linear.status = "off";
    return;
  }
  try {
    Linear.warning = "";
    Linear.viewer = await linearVerify();
    Linear.remote = await linearPull();
    Linear.status = "ready";
  } catch (err) {
    Linear.status = "error";
    Linear.error = err.message;
  }
}

const linearConnected = () => Linear.status === "ready";
