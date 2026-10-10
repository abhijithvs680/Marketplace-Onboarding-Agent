#!/usr/bin/env node
/**
 * Vizru platform probe.
 *
 * Exercises the running stack and prints what each surface actually returns, so
 * a claim in SKILL.md can be re-checked rather than trusted. Everything runs
 * through `docker exec` because the platform's services are on an internal
 * compose network and are not published to the host — receiver-web exposes only
 * 443 inside the network, and mcp-server only 9101.
 *
 * Usage:
 *   node probe.mjs                      every section
 *   node probe.mjs mcp http             just those
 *   VIZRU_TID=204 node probe.mjs mcp    against another tenant
 *
 * Sections: containers mcp http mongo mysql sync
 * Exit code is the number of failed checks, capped at 125.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const TID = process.env.VIZRU_TID || '';
const SS_CODE = process.env.VIZRU_SS_CODE || '';
const MCP_USER = process.env.VIZRU_MCP_API_USER || 'vizru';
const MCP_SECRET = process.env.VIZRU_MCP_API_SECRET || 'vizru_secret_key';
const MONGO_URI =
  process.env.VIZRU_MONGO_URI || 'mongodb://vizru:vizru@localhost:27017/vizru-live';

const ALL_SECTIONS = ['containers', 'mcp', 'http', 'mongo', 'mysql', 'sync'];

let failures = 0;

/* ------------------------------------------------------------------ output - */

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

function section(name) {
  process.stdout.write(`\n${C.bold}══ ${name} ${'═'.repeat(Math.max(0, 66 - name.length))}${C.off}\n`);
}

function ok(label, detail = '') {
  process.stdout.write(`  ${C.green}PASS${C.off} ${label}${detail ? ` ${C.dim}${detail}${C.off}` : ''}\n`);
}

function bad(label, detail = '') {
  failures++;
  process.stdout.write(`  ${C.red}FAIL${C.off} ${label}${detail ? ` ${C.dim}${detail}${C.off}` : ''}\n`);
}

function warn(label, detail = '') {
  process.stdout.write(`  ${C.yellow}NOTE${C.off} ${label}${detail ? ` ${C.dim}${detail}${C.off}` : ''}\n`);
}

function info(text) {
  process.stdout.write(`       ${C.dim}${text}${C.off}\n`);
}

/** One line, clipped, with newlines flattened — probe output stays scannable. */
function clip(value, max = 150) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ------------------------------------------------------------- docker exec - */

async function dockerExec(container, argv, { allowFail = true } = {}) {
  try {
    const { stdout, stderr } = await run('docker', ['exec', container, ...argv], {
      maxBuffer: 24 * 1024 * 1024,
      timeout: 90_000,
    });
    return { ok: true, out: stdout, err: stderr };
  } catch (e) {
    if (!allowFail) throw e;
    return { ok: false, out: e.stdout || '', err: e.stderr || String(e.message || e) };
  }
}

/** Run Python inside mcp-server. It has no curl, so urllib is the HTTP client. */
function mcpPython(body) {
  return dockerExec('mcp-server', ['python', '-c', body]);
}

/** Run curl inside receiver-web against its own HTTPS listener. */
function webCurl(args) {
  return dockerExec('receiver-web', ['sh', '-c', `curl -sk ${args}`]);
}

function mongoEval(js) {
  return dockerExec('receiver-mongo', ['mongosh', MONGO_URI, '--quiet', '--eval', js]);
}

function mysqlQuery(sql) {
  return dockerExec('receiver-mysql', [
    'sh', '-c',
    `mysql -uvizru -pvizru vizru -N -e ${JSON.stringify(sql)} 2>/dev/null`,
  ]);
}

/* ------------------------------------------------------- section: containers */

const REQUIRED = [
  'receiver-web', 'receiver-mysql', 'receiver-mongo', 'receiver-redis',
  'receiver-chatsystem', 'mcp-server',
];

async function probeContainers() {
  section('containers');
  let names = [];
  try {
    const { stdout } = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], { timeout: 30_000 });
    names = stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  } catch (e) {
    bad('docker ps', clip(e.message));
    return false;
  }

  const running = new Map(names);
  for (const want of REQUIRED) {
    if (running.has(want)) ok(want, running.get(want));
    else bad(want, 'not running — start the stack before probing');
  }
  const extra = [...running.keys()].filter((n) => !REQUIRED.includes(n) && n.startsWith('receiver-'));
  if (extra.length) info(`also up: ${extra.join(', ')}`);
  return REQUIRED.every((n) => running.has(n));
}

/* -------------------------------------------------------------- section: mcp */

/**
 * The Python helper every MCP check shares. Prints `STATUS<TAB>BODY` per call
 * so the Node side can assert on both without a second round trip.
 */
const MCP_HELPER = `
import urllib.request, urllib.error, base64, json, sys
AUTH = 'Basic ' + base64.b64encode(b'${MCP_USER}:${MCP_SECRET}').decode()
def call(path, data=None, auth=True):
    req = urllib.request.Request('http://localhost:9101' + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json'})
    if auth: req.add_header('Authorization', AUTH)
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, str(e)
def emit(tag, path, data=None, auth=True):
    code, body = call(path, data, auth)
    print(tag + '\\t' + str(code) + '\\t' + body.replace('\\n', ' '))
`;

/** Pick a tenant + mirror table that actually exist, so checks are meaningful. */
async function pickMirror() {
  if (TID && SS_CODE) return { tid: TID, code: SS_CODE, table: `ss_${SS_CODE.toLowerCase()}` };

  const res = await mcpPython(`
import db, os, re
db.open_pool()
rows = db.run_select(
    "SELECT table_schema, table_name FROM information_schema.tables "
    "WHERE table_name LIKE 'ss\\\\_%' ORDER BY 1, 2", 200, 'public')
for r in rows:
    schema = r['table_schema']
    if re.fullmatch(r't\\d+', schema or ''):
        print(schema[1:] + '\\t' + r['table_name'])
`);
  const line = res.out.trim().split('\n').filter(Boolean)[0];
  if (!line) return null;
  const [tid, table] = line.split('\t');
  return { tid, code: table.replace(/^ss_/, ''), table };
}

async function probeMcp() {
  section('mcp-server :9101');

  const env = await dockerExec('mcp-server', [
    'sh', '-c',
    'env | grep -E "^(MAX_ROWS|STATEMENT_TIMEOUT_MS|MIRROR_|SYNC_|REDIS_HOST|REDIS_DB)=" | sort',
  ]);
  if (env.out.trim()) {
    info('effective config (do not trust the README over this):');
    for (const l of env.out.trim().split('\n')) info(`  ${l}`);
  }

  const health = await mcpPython(`${MCP_HELPER}\nemit('health', '/health', auth=False)`);
  const [, hcode, hbody] = (health.out.trim().split('\n')[0] || '').split('\t');
  if (hcode === '200' && (hbody || '').includes('"ok"')) ok('GET /health', hbody);
  else bad('GET /health', `${hcode} ${clip(hbody)}`);

  const unauth = await mcpPython(
    `${MCP_HELPER}\nemit('unauth', '/api/query', {'query': 'SELECT 1', 'tid': 1}, auth=False)`,
  );
  const ucode = (unauth.out.trim().split('\t')[1] || '').trim();
  if (ucode === '401') ok('basic auth enforced on /api/query', '401 without credentials');
  else bad('basic auth on /api/query', `expected 401, got ${ucode}`);

  const tools = await mcpPython(
    `${MCP_HELPER}\nemit('tools', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})`,
  );
  const tbody = tools.out.split('\t')[2] || '';
  try {
    const names = JSON.parse(tbody).result.tools.map((t) => t.name);
    ok('POST /mcp tools/list', names.join(', '));
    for (const want of ['query_database', 'describe_spreadsheet']) {
      if (!names.includes(want)) bad(`MCP tool ${want} missing`);
    }
  } catch {
    bad('POST /mcp tools/list', clip(tbody));
  }

  // Guard layers. These must refuse regardless of which tenant we land on.
  const guards = await mcpPython(`${MCP_HELPER}
emit('write',    '/api/query', {'query': 'DELETE FROM ss_x', 'tid': 1})
emit('notid',    '/api/query', {'query': 'SELECT 1'})
emit('qualified','/api/query', {'query': 'SELECT * FROM t1.ss_x LIMIT 1', 'tid': 1})
emit('multi',    '/api/query', {'query': 'SELECT 1; SELECT 2', 'tid': 1})
emit('forshare', '/api/query', {'query': 'SELECT * FROM ss_x FOR SHARE', 'tid': 1})
`);
  const expected = {
    write: [400, /Only SELECT/i, 'write verbs refused'],
    notid: [400, /tenant id/i, 'missing tid refused'],
    qualified: [400, /Schema-qualified/i, 'schema-qualified name refused'],
    multi: [400, /./, 'multi-statement refused'],
  };
  const guardRows = new Map(
    guards.out.trim().split('\n').filter(Boolean).map((l) => {
      const [tag, code, ...rest] = l.split('\t');
      return [tag, { code: Number(code), body: rest.join('\t') }];
    }),
  );
  for (const [tag, [wantCode, wantBody, label]] of Object.entries(expected)) {
    const got = guardRows.get(tag);
    if (got && got.code === wantCode && wantBody.test(got.body)) ok(label, clip(got.body, 90));
    else bad(label, got ? `${got.code} ${clip(got.body, 90)}` : 'no response');
  }
  // FOR SHARE takes row locks and trips no keyword: the read-only session is
  // what rejects it, so the status depends on whether the table resolves.
  const forShare = guardRows.get('forshare');
  if (forShare) info(`SELECT … FOR SHARE → ${forShare.code} ${clip(forShare.body, 90)}`);

  const mirror = await pickMirror();
  if (!mirror) {
    warn('no ss_* mirror table found in any tenant schema');
    info('Nothing is synced. /api/schema will 404 and every query will say');
    info('"relation does not exist". Turn on general-settings.Autosync for a');
    info('sheet, or set VIZRU_TID / VIZRU_SS_CODE to one that is mirrored.');
    return;
  }
  info(`using tenant ${mirror.tid}, spreadsheet ${mirror.code} → ${mirror.table}`);

  const live = await mcpPython(`${MCP_HELPER}
emit('schema', '/api/schema?shortcode=${mirror.code}&tid=${mirror.tid}')
emit('query',  '/api/query', {'query': 'SELECT "_row_id", "_synced_at" FROM ${mirror.table} LIMIT 2', 'tid': ${mirror.tid}})
emit('narrow', '/api/query', {'query': 'SELECT * FROM ${mirror.table} LIMIT 1', 'tid': ${mirror.tid}, 'allowed_tables': ['ss_not_this_one']})
`);
  const rows = new Map(
    live.out.trim().split('\n').filter(Boolean).map((l) => {
      const [tag, code, ...rest] = l.split('\t');
      return [tag, { code: Number(code), body: rest.join('\t') }];
    }),
  );

  const schema = rows.get('schema');
  if (schema?.code === 200) {
    try {
      const parsed = JSON.parse(schema.body);
      const meta = parsed.columns.filter((c) => c.label === null).map((c) => c.name);
      const labelled = parsed.columns.filter((c) => c.label !== null);
      const indexed = labelled.filter((c) => /^indexColumnNo\d+$/.test(c.name));
      ok('GET /api/schema', `${parsed.columns.length} columns on ${parsed.table}`);
      info(`mirror-owned: ${meta.join(', ') || '(none)'}`);
      info(`indexed keys: ${indexed.map((c) => `${c.name}=${c.label}`).join(', ') || '(none)'}`);
      const sample = labelled.find((c) => !/^indexColumnNo/.test(c.name));
      if (sample) {
        info(`hashed key → label: ${sample.name} = "${sample.label}" (${sample.type})`);
        info('SQL must use the name, never the label — this is rule 1 in SKILL.md.');
      }
    } catch {
      bad('GET /api/schema parse', clip(schema.body));
    }
  } else {
    bad('GET /api/schema', `${schema?.code} ${clip(schema?.body)}`);
  }

  const query = rows.get('query');
  if (query?.code === 200 && query.body.trimStart().startsWith('[')) {
    const parsed = JSON.parse(query.body);
    ok('POST /api/query', `bare JSON array, ${parsed.length} row(s)`);
    if (parsed[0]) info(`first row: ${clip(JSON.stringify(parsed[0]), 120)}`);
  } else {
    bad('POST /api/query', `${query?.code} ${clip(query?.body)}`);
  }

  const narrow = rows.get('narrow');
  if (narrow?.code === 400 && /not available/i.test(narrow.body)) {
    ok('allowed_tables narrows within a tenant', clip(narrow.body, 90));
  } else {
    bad('allowed_tables narrowing', `${narrow?.code} ${clip(narrow?.body, 90)}`);
  }

  // Tenant isolation: the same bare name must not resolve under another tid.
  const otherTid = String(Number(mirror.tid) + 1);
  const cross = await mcpPython(
    `${MCP_HELPER}\nemit('cross', '/api/query', {'query': 'SELECT * FROM ${mirror.table} LIMIT 1', 'tid': ${otherTid}})`,
  );
  const cbody = cross.out.split('\t').slice(2).join('\t');
  if (/does not exist/i.test(cbody)) {
    ok('tenant isolation via search_path', `tid ${otherTid} cannot see ${mirror.table}`);
  } else {
    bad('tenant isolation', clip(cbody, 120));
  }
}

/* ------------------------------------------------------------- section: http */

async function probeHttp() {
  section('platform HTTP (receiver-web)');

  const envelope = await webCurl(
    '-X POST https://localhost/sys/api.v1 -d "op=livespace.spreadsheet.spreadsheetdetails"',
  );
  try {
    const parsed = JSON.parse(envelope.out);
    if (parsed.Status?.[0] === 401) {
      ok('POST /sys/api.v1 without auth', '401 inside a 200-shaped envelope');
      info(`envelope keys: ${Object.keys(parsed).join(', ')}`);
      info('Status is in the BODY, not only the HTTP status — parse the envelope.');
    } else {
      warn('POST /sys/api.v1', `unexpected Status ${JSON.stringify(parsed.Status)}`);
    }
  } catch {
    bad('POST /sys/api.v1 envelope', clip(envelope.out));
  }

  const bogusBearer = await webCurl(
    '-o /dev/null -w "%{http_code}" -X POST https://localhost/sys/api.v1'
    + ' -H "Authorization: Bearer not.a.jwt" -d "op=livespace.spreadsheet.spreadsheetdetails"',
  );
  const bb = bogusBearer.out.trim();
  if (bb === '500') {
    ok('malformed bearer on /sys/api.v1', '500 — decodeJWT throws, it is not a clean 401');
  } else {
    warn('malformed bearer on /sys/api.v1', `got ${bb} (SKILL.md records 500)`);
  }

  const missing = await webCurl(
    '-o /dev/null -w "%{http_code}" -X POST https://localhost/workflow.trigger/definitely-not-a-workflow',
  );
  if (missing.out.trim() === '404') ok('workflow.trigger unknown shortCode', '404');
  else bad('workflow.trigger unknown shortCode', `expected 404, got ${missing.out.trim()}`);

  const execAuth = await webCurl(
    '-o /dev/null -w "%{http_code}" -X POST https://localhost/workflow.exec/definitely-not-a-workflow',
  );
  // An unknown shortcode redirects to / before the session check, so this only
  // shows 401 when the workflow actually resolves. 302 here is expected.
  info(`workflow.exec, unknown shortCode, no session → ${execAuth.out.trim()} (302 = redirect to /;`
    + ' a workflow that resolves answers 401)');

  // A real trigger workflow, so CORS and routing are checked against one.
  const found = await mongoEval(`
const d = db.VizWorkflow.aggregate([
  { $match: { deleted: { $ne: 'true' } } },
  { $unwind: '$w_objects' },
  { $match: { 'w_objects.type': { $in: ['genericpost', 'genericget'] }, 'w_objects.source': 0 } },
  { $project: { short_code: 1, type: '$w_objects.type',
                auth: '$w_objects.block_properties.auth_required' } },
  { $limit: 1 },
]).toArray()[0];
print(d ? [d.short_code, d.type, d.auth].join('\\t') : '');
`);
  const [code, type, auth] = (found.out.trim().split('\n').pop() || '').split('\t');
  if (!code) {
    warn('no genericpost/genericget workflow found', 'skipping CORS + routing check');
    info('Only a workflow whose FIRST block is a trigger block is callable');
    info('over workflow.trigger. Everything else answers 404 or falls through.');
    return;
  }
  info(`using workflow ${code} (${type}, auth_required=${auth})`);

  const preflight = await webCurl(
    `-D - -o /dev/null -X OPTIONS https://localhost/workflow.trigger/${code} -H "Origin: http://localhost:3000"`,
  );
  const cors = preflight.out
    .split('\n')
    .filter((l) => /^(access-control|vary)/i.test(l.trim()))
    .map((l) => l.trim());
  if (cors.some((l) => /allow-origin: http:\/\/localhost:3000/i.test(l))) {
    ok('CORS preflight for http://localhost:3000');
    for (const l of cors) info(l);
    info('The allow-list is HARD-CODED in sys/controllers/workflow/Trigger.php:');
    info('http://localhost:3000, https://baines.healthcare, *.vizru-ras.com.');
    info('Any other browser origin gets no CORS headers — add yours there.');
  } else {
    bad('CORS preflight', cors.join(' | ') || 'no CORS headers returned');
  }

  const post = await webCurl(
    `-o /dev/null -w "%{http_code}" -X POST https://localhost/workflow.trigger/${code}`
    + ' -H "Content-Type: application/json" -d "{}"',
  );
  const pc = post.out.trim();
  if (pc === '200') {
    ok(`POST /workflow.trigger/${code}`, '200 (public — auth_required is "0")');
    info('A 200 says the workflow RAN, not that it succeeded: a failing block');
    info('still answers 200 with "Internal Server Error" as the body.');
  } else {
    warn(`POST /workflow.trigger/${code}`, `${pc} — likely auth_required=1`);
  }
}

/* ------------------------------------------------------------ section: mongo */

async function probeMongo() {
  section('mongo (workflow + spreadsheet documents)');

  const collections = await mongoEval(`
const want = ['VizWorkflow', 'VizSpreadsheet', 'VizSpreadsheetRows', 'VizWorkflowLog',
              'VizWorkflowVersions', 'VizJobStatus', 'VizWorkflowUniqueValidator'];
const have = new Set(db.getCollectionNames());
want.forEach(c => print(c + '\\t' + (have.has(c) ? db[c].countDocuments({}, { limit: 1 }) >= 0 : 'MISSING')));
`);
  for (const line of collections.out.trim().split('\n').filter(Boolean)) {
    const [name, state] = line.split('\t');
    if (state === 'MISSING') warn(`${name} absent`, 'created on first write');
    else ok(name, 'present');
  }

  const shape = await mongoEval(`
const s = db.VizSpreadsheet.findOne({ header: { $exists: true, $ne: [] } });
if (!s) { print('NO_SHEET'); } else {
  print('DOCKEYS\\t' + Object.keys(s).join(', '));
  print('TITLE\\t' + s.title + '\\t' + s.short_code + '\\ttid=' + s._tid);
  print('HEADER\\t' + JSON.stringify(s.header.slice(0, 5)));
  const cs = s['column-settings'] || {};
  const k = Object.keys(cs)[0];
  print('COLSET\\t' + (k ? k + ' => ' + JSON.stringify(cs[k]).slice(0, 220) : '(none)'));
  print('GENSET\\t' + JSON.stringify(s['general-settings'] || {}));
  const r = db.VizSpreadsheetRows.findOne({ ssid: s._id });
  print('ROW\\t' + (r ? Object.keys(r).join(', ') : '(no rows for this sheet)'));
}
`);
  if (shape.out.includes('NO_SHEET')) {
    warn('no spreadsheet with a header found');
  } else {
    for (const line of shape.out.trim().split('\n').filter((l) => l.includes('\t'))) {
      const [tag, ...rest] = line.split('\t');
      const body = rest.join(' ');
      if (tag === 'HEADER') {
        ok('spreadsheet header document');
        info(clip(body, 300));
        info('Index 0/1/2 are always row_id / updated_by / row_meta.');
        info('From index 3 each entry is { md5ColumnKey: "Visible Heading" }.');
      } else if (tag === 'DOCKEYS') {
        info(`VizSpreadsheet keys: ${body}`);
      } else if (tag === 'COLSET') {
        info(`column-settings: ${clip(body, 240)}`);
      } else if (tag === 'GENSET') {
        info(`general-settings: ${clip(body, 200)}`);
      } else if (tag === 'ROW') {
        info(`VizSpreadsheetRows keys: ${clip(body, 240)}`);
      } else if (tag === 'TITLE') {
        info(`sheet: ${body}`);
      }
    }
  }

  const wf = await mongoEval(`
const w = db.VizWorkflow.findOne({ w_objects: { $exists: true, $ne: [] }, deleted: { $ne: 'true' } });
if (!w) { print('NO_WF'); } else {
  print('WFKEYS\\t' + Object.keys(w).join(', '));
  print('LOG\\tenable_log=' + w.enable_log + ' schedule=' + w.schedule + ' name=' + w.name);
  w.w_objects.slice(0, 4).forEach(o => print('BLOCK\\t' + o.type + ' id=' + o.id +
    ' obj_id=' + o.obj_id + ' source=' + o.source + ' target=' + o.target));
  print('CONN\\t' + JSON.stringify((w.connection || []).slice(0, 2)));
}
`);
  if (wf.out.includes('NO_WF')) {
    warn('no workflow with blocks found');
  } else {
    ok('VizWorkflow document');
    for (const line of wf.out.trim().split('\n').filter((l) => l.includes('\t'))) {
      const [tag, ...rest] = line.split('\t');
      info(`${tag === 'BLOCK' ? '  ' : ''}${clip(rest.join(' '), 220)}`);
    }
    info('enable_log is INVERTED: the engine logs when enable_log != "1".');
    info('Block ids are <obj_id>_<sequence>; obj_id is the palette number.');
  }
}

/* ------------------------------------------------------------ section: mysql */

async function probeMysql() {
  section('mysql (the ssid ↔ short_code map)');

  const tables = await mysqlQuery(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='vizru'"
    + " AND table_name IN ('viz_livespace_files','viz_users','viz_sessions',"
    + "'viz_workflow_exec_log','viz_livespace','viz_livespace_collection')",
  );
  const present = tables.out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  for (const t of ['viz_livespace_files', 'viz_users', 'viz_sessions', 'viz_workflow_exec_log']) {
    if (present.includes(t)) ok(t, 'present');
    else bad(t, 'missing');
  }

  const sheets = await mysqlQuery(
    "SELECT tid, lid, short_code, dir_path, title FROM viz_livespace_files"
    + " WHERE mime_type='spreadsheet' AND flags!=0 LIMIT 3",
  );
  const rows = sheets.out.trim().split('\n').filter(Boolean);
  if (rows.length) {
    ok('viz_livespace_files resolves spreadsheets', `${rows.length} sample row(s)`);
    info('tid | lid | short_code | dir_path (= the Mongo ssid) | title');
    for (const r of rows) info(`  ${clip(r.replace(/\t/g, ' | '), 170)}`);
    info('dir_path IS the VizSpreadsheet _id. Every shortcode lookup in the');
    info('platform goes through this table, not through Mongo.');
  } else {
    warn('no spreadsheet rows in viz_livespace_files');
  }

  const mimes = await mysqlQuery(
    "SELECT mime_type, COUNT(*) FROM viz_livespace_files WHERE flags!=0"
    + " GROUP BY mime_type ORDER BY 2 DESC LIMIT 8",
  );
  if (mimes.out.trim()) {
    info('document types in viz_livespace_files (mime_type = the kind of doc):');
    for (const r of mimes.out.trim().split('\n')) info(`  ${r.replace(/\t/g, '  ')}`);
  }
}

/* ------------------------------------------------------------- section: sync */

async function probeSync() {
  section('spreadsheet → postgres sync pipeline');

  const depth = await dockerExec('receiver-redis', [
    'sh', '-c', 'redis-cli -a test -n 1 LLEN vizru:ss-sync:events 2>/dev/null',
  ]);
  const n = depth.out.trim();
  if (/^\d+$/.test(n)) {
    ok('redis queue vizru:ss-sync:events reachable', `depth ${n}`);
    if (n !== '0') info('A non-zero depth means the worker is behind or stopped.');
  } else {
    bad('redis queue', clip(depth.out || depth.err));
  }

  const workerEnv = await dockerExec('mcp-server', [
    'sh', '-c', 'env | grep -E "^(SYNC_WORKER_ENABLED|SYNC_QUEUE_KEY|MONGO_URI)=" | sed "s#://[^@]*@#://***@#"',
  ]);
  for (const l of workerEnv.out.trim().split('\n').filter(Boolean)) info(l);

  const enabled = await mongoEval(`
const n = db.VizSpreadsheet.countDocuments({ 'general-settings.Autosync': { $exists: true, $nin: ['', null, false, 0, '0'] } });
print('AUTOSYNC\\t' + n);
const keys = {};
db.VizSpreadsheet.find({ 'general-settings': { $exists: true } }, { 'general-settings': 1 })
  .limit(200).forEach(d => Object.keys(d['general-settings'] || {}).forEach(k => keys[k] = (keys[k] || 0) + 1));
print('KEYS\\t' + JSON.stringify(keys));
`);
  const autosync = (enabled.out.match(/AUTOSYNC\t(\d+)/) || [])[1];
  if (autosync === '0' || autosync === undefined) {
    warn('no spreadsheet has general-settings.Autosync enabled');
    info('Sync::isEnabled() is false for every sheet, so nothing is being');
    info('queued. Existing ss_* mirrors were written by an older external');
    info('pipeline and will go stale. Do not assume SQL access is live.');
  } else {
    ok('sheets with Autosync on', autosync);
  }
  const keys = (enabled.out.match(/KEYS\t(.*)$/m) || [])[1];
  if (keys) info(`general-settings keys in use: ${clip(keys, 220)}`);

  const mirrors = await mcpPython(`
import db, re
db.open_pool()
rows = db.run_select("SELECT table_schema, count(*) AS n FROM information_schema.tables "
                     "WHERE table_name LIKE 'ss\\\\_%' GROUP BY 1 ORDER BY 1", 100, 'public')
for r in rows:
    if re.fullmatch(r't\\d+', r['table_schema'] or ''):
        print(r['table_schema'] + '\\t' + str(r['n']))
`);
  const lines = mirrors.out.trim().split('\n').filter((l) => l.includes('\t'));
  if (lines.length) {
    ok('mirror tables in postgres', lines.map((l) => l.replace('\t', ': ')).join(', '));
    info('Schema tN is tenant N (tenant.py: schema_for). One schema per tenant.');
  } else {
    warn('no ss_* mirror tables in any tenant schema');
  }
}

/* -------------------------------------------------------------------- driver */

const HANDLERS = {
  containers: probeContainers,
  mcp: probeMcp,
  http: probeHttp,
  mongo: probeMongo,
  mysql: probeMysql,
  sync: probeSync,
};

async function main() {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const unknown = asked.filter((a) => !ALL_SECTIONS.includes(a));
  if (unknown.length) {
    process.stderr.write(`unknown section(s): ${unknown.join(', ')}\nknown: ${ALL_SECTIONS.join(' ')}\n`);
    process.exit(2);
  }
  const sections = asked.length ? asked : ALL_SECTIONS;

  process.stdout.write(`${C.bold}Vizru platform probe${C.off} ${C.dim}— sections: ${sections.join(', ')}${C.off}\n`);

  // Nothing else can pass if the containers are down, so bail early on a
  // full run rather than printing six pages of connection errors.
  if (sections.includes('containers')) {
    const up = await probeContainers();
    if (!up && sections.length > 1) {
      process.stdout.write(`\n${C.red}Containers are not all up; skipping the rest.${C.off}\n`);
      process.exit(Math.min(failures, 125));
    }
  }

  for (const name of sections) {
    if (name === 'containers') continue;
    try {
      await HANDLERS[name]();
    } catch (e) {
      bad(`section ${name} threw`, clip(e.message));
    }
  }

  process.stdout.write(
    failures === 0
      ? `\n${C.green}All checks passed.${C.off}\n`
      : `\n${C.red}${failures} check(s) failed.${C.off}\n`,
  );
  process.exit(Math.min(failures, 125));
}

main();
