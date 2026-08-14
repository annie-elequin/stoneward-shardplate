/* Linear sync — personal API key, browser-direct GraphQL, no backend.
   Linear serves permissive CORS to this origin and allows POST with an
   Authorization header, so the static site can talk to the API itself. */

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const STORE_LINEAR_KEY = "shardplate.linearkey.v1";

const Linear = {
  map: null, // linear-map.json, once fetched
  viewer: null, // { id, name } when a key is verified
  remote: {}, // stepId -> true when the issue is in a completed state
  status: "off", // off | unseeded | error | ready
  error: "",
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
   250-node page and Linear's per-query complexity ceiling. */
async function linearPull() {
  const ids = Object.values(Linear.map.steps);
  const data = await linearGql(
    `query($ids:[ID!]) {
      issues(filter: { id: { in: $ids } }, first: 250) {
        nodes { id state { type } }
      }
    }`,
    { ids }
  );

  const completed = new Set(
    data.issues.nodes.filter((n) => n.state && n.state.type === "completed").map((n) => n.id)
  );
  const remote = {};
  for (const [stepId, issueId] of Object.entries(Linear.map.steps)) {
    if (completed.has(issueId)) remote[stepId] = true;
  }
  return remote;
}

async function linearPush(stepId, done) {
  const issueId = Linear.map && Linear.map.steps[stepId];
  if (!issueId) throw new Error(`Step ${stepId} has no Linear issue mapped to it`);

  const stateId = done ? Linear.map.states.done : Linear.map.states.todo;
  const data = await linearGql(
    `mutation($id:String!, $stateId:String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId }
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
    Linear.viewer = await linearVerify();
    Linear.remote = await linearPull();
    Linear.status = "ready";
  } catch (err) {
    Linear.status = "error";
    Linear.error = err.message;
  }
}

const linearConnected = () => Linear.status === "ready";
